// @vitest-environment happy-dom
/**
 * The artifact smoke test: drive the **built** bundle —
 * `dist/tessera-respond.es.js`, produced by the `pnpm build` step the `test`
 * script runs first — fully offline with mock props. It proves what only the
 * artifact can: the bundle is genuinely self-contained (importing it from a
 * bare DOM environment registers the element with no missing peer), styles
 * arrive in the shadow root via the constructed stylesheets, props flow
 * through solid-element (properties and attributes), events cross the shadow
 * boundary, and — for a sealed definition — the tlock/evolution chunks
 * lazy-load and produce a real ciphertext (timelock encryption needs no
 * network). The real-on-chain end-to-end lives in the app's DevWidgetHost page.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  Role,
  SPEC_VERSION,
  decodePayload,
  validateResponse,
  type SubmissionMode,
  type SurveyDefinition,
} from "cip-179";
import { hexToBytes, refKey } from "cip-179/domain";
import { QUICKNET_CHAIN_HASH } from "cip-179/tlock";
import { buildResponse } from "cardano-tessera-respond-core";

import {
  CONDITIONS,
  NONE_LABELS,
  SAMPLES,
  SURVEY_REFS,
  TIP_EPOCH,
  TRANSLATIONS,
  responder,
} from "../dev/samples";
import type { RespondResult, TesseraRespondElement } from "../src/types";

/**
 * happy-dom's IntersectionObserver never reports. This one reports what it
 * observes as on screen while `onScreen` holds: at once, and on `scrolled()`.
 */
let onScreen = true;
const observers = new Set<() => void>();
class ScreenObserver {
  readonly #targets = new Set<Element>();
  readonly #report: () => void;
  constructor(callback: IntersectionObserverCallback) {
    this.#report = () => {
      const entries = [...this.#targets].map(
        (target) =>
          ({ target, isIntersecting: true }) as IntersectionObserverEntry,
      );
      if (onScreen && entries.length > 0)
        callback(entries, this as unknown as IntersectionObserver);
    };
    observers.add(this.#report);
  }
  observe(target: Element): void {
    this.#targets.add(target);
    this.#report();
  }
  unobserve(target: Element): void {
    this.#targets.delete(target);
  }
  disconnect(): void {
    this.#targets.clear();
    observers.delete(this.#report);
  }
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
}
const scrolled = () => {
  for (const report of [...observers]) report();
};

beforeAll(async () => {
  globalThis.IntersectionObserver =
    ScreenObserver as unknown as typeof IntersectionObserver;
  // Importing the artifact registers <tessera-respond> as a side effect.
  await import("../dist/tessera-respond.es.js");
});

afterEach(() => {
  document.body.innerHTML = "";
  onScreen = true;
});

/** A single-question definition so submit tests need exactly one click. */
function oneQuestionDef(submissionMode: SubmissionMode): SurveyDefinition {
  return {
    specVersion: SPEC_VERSION,
    owner: { type: "key", keyHash: hexToBytes("00".repeat(28)) },
    title: "Artifact smoke survey",
    description: "One question, answered by the test via DOM clicks.",
    eligibleRoles: [Role.Keyholder],
    endEpoch: 600,
    submissionMode,
    questions: [
      {
        type: "singleChoice",
        prompt: "Pick one",
        required: true,
        options: { type: "options", labels: ["First", "Second"] },
      },
    ],
  };
}

/** Create the element, assign the host props, connect it. */
function mount(
  definition: SurveyDefinition,
  extra: Partial<TesseraRespondElement> = {},
): TesseraRespondElement {
  const el = document.createElement("tessera-respond");
  el.definition = definition;
  el.surveyRef = SURVEY_REFS.public;
  el.responder = responder;
  el.tipEpoch = TIP_EPOCH;
  Object.assign(el, extra);
  document.body.appendChild(el);
  return el;
}

function shadow(el: HTMLElement): ShadowRoot {
  const root = el.shadowRoot;
  expect(root, "the element should render into an open shadow root").not.toBe(
    null,
  );
  return root!;
}

function click(root: ShadowRoot, selector: string): void {
  const target = root.querySelector<HTMLElement>(selector);
  expect(target, `expected ${selector} in the shadow root`).not.toBe(null);
  target!.click();
}

/** Send a key down from `target`, as a browser does; returns the event. */
function keydown(
  target: Element,
  key: string,
  init: KeyboardEventInit = {},
): KeyboardEvent {
  const e = new KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    composed: true,
    ...init,
  });
  target.dispatchEvent(e);
  return e;
}

/** Await one event of `type` on `el` (they bubble, composed, to the host). */
function once(
  el: EventTarget,
  type: string,
  timeoutMs = 60_000,
): Promise<CustomEvent> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out waiting for ${type}`)),
      timeoutMs,
    );
    el.addEventListener(
      type,
      (e) => {
        clearTimeout(timer);
        resolve(e as CustomEvent);
      },
      { once: true },
    );
  });
}

describe("built <tessera-respond> artifact", () => {
  it("keeps the sealed machinery out of the static import graph", () => {
    // Walk the artifact's static `import ... from "./x"` edges from the entry;
    // whatever is left must be reachable only through a dynamic `import()` —
    // the tlock + evolution chunks a public-survey host never downloads.
    const dist = join(dirname(fileURLToPath(import.meta.url)), "../dist");
    const files = readdirSync(dist).filter((f) => f.endsWith(".js"));
    const staticDeps = (f: string): string[] => {
      const text = readFileSync(join(dist, f), "utf8");
      return [
        ...text.matchAll(/from\s*"\.\/([^"]+)"/g),
        ...text.matchAll(/import\s*"\.\/([^"]+)"/g),
      ].map((m) => m[1]!);
    };
    const reachable = new Set(["tessera-respond.es.js"]);
    for (const f of reachable) {
      for (const dep of staticDeps(f)) reachable.add(dep);
    }
    const lazy = files.filter((f) => !reachable.has(f));
    expect(lazy.length, "expected lazy chunks").toBeGreaterThanOrEqual(2);
    // And the lazy side is the heavy one: the public path ships the minority
    // of the bytes.
    const bytes = (fs: string[]): number =>
      fs.reduce((sum, f) => sum + statSync(join(dist, f)).size, 0);
    expect(bytes([...reachable])).toBeLessThan(bytes(lazy));
  });

  it("renders the survey into a styled shadow root once props are set", () => {
    const el = mount(SAMPLES.public);
    const root = shadow(el);
    expect(root.querySelector(".root")).not.toBe(null);
    expect(root.querySelector(".headerTitle")?.textContent).toBe(
      "Public demo survey",
    );
    // Default layout is the stepper: one question card + prev/next nav.
    expect(root.querySelectorAll(".card").length).toBe(1);
    expect(root.querySelector(".stepperNav")).not.toBe(null);
    // Styles arrived: the shared constructed sheet, or the <style> fallback.
    const styled =
      root.adoptedStyleSheets.length > 0 ||
      root.querySelector("style") !== null;
    expect(styled).toBe(true);
  });

  it("stays in lockstep with the plain-HTML demo page", async () => {
    // Run demo/index.html's own inline module — its DOM, its mock data, its
    // wiring — against the built bundle, so prop-shape drift in the demo
    // fails CI instead of silently rendering a not-eligible state.
    const html = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "../demo/index.html"),
      "utf8",
    );
    const body = html.slice(
      html.indexOf("<body>") + "<body>".length,
      html.indexOf("</body>"),
    );
    // innerHTML never executes scripts; drop the tag and run its code
    // directly (minus the artifact import — beforeAll already registered).
    const script = /<script type="module">([\s\S]*?)<\/script>/.exec(html)![1]!;
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/, "");
    new Function(script.replace(/^\s*import\b[^\n]*\n/gm, ""))();

    const el = document.getElementById("widget")!;
    const root = shadow(el);
    expect(root.querySelector(".headerTitle")?.textContent).toBe(
      "Artifact demo survey",
    );
    // The demo responder is eligible: an answerable card, not a notice.
    expect(root.querySelector(".card")).not.toBe(null);
    expect(root.querySelector(".noticeTitle")).toBe(null);

    // And the demo's own listeners work: answering lands in its on-page log.
    const changed = once(el, "tessera:change");
    click(root, ".optionRow");
    await changed;
    expect(document.getElementById("log")!.textContent).toContain(
      "tessera:change",
    );

    // Submit all the way through: the demo's hard-coded specVersion (it can't
    // import SPEC_VERSION) must match what the widget builds, or every submit
    // dies with a specVersionMismatch the render-only checks above never see.
    click(root, ".stepperNav .stepNavBtn:last-child");
    click(root, ".skipBtn");
    const responded = once(el, "tessera:response");
    click(root, ".submitBtn");
    await responded;
    expect(document.getElementById("log")!.textContent).toContain(
      "tessera:response",
    );
  });

  it("renders every question at once in the list layout", () => {
    const el = mount(SAMPLES.public, { layout: "list" });
    const root = shadow(el);
    // One card per question in the all-types sample; no stepper.
    expect(root.querySelectorAll(".card").length).toBe(
      SAMPLES.public.questions.length,
    );
    expect(root.querySelector(".stepperNav")).toBe(null);
  });

  it("leaves out the anchor and hint of a hidden schema", () => {
    const custom = SAMPLES.public.questions.find((q) => q.type === "custom");
    if (custom?.type !== "custom") throw new Error("no custom sample");
    const el = mount(SAMPLES.public, { layout: "list" });
    const root = shadow(el);
    expect(root.querySelector(".customSchema")).not.toBe(null);
    expect(root.querySelector(".customHint")).not.toBe(null);
    el.hiddenSchemas = [custom.methodSchema.uri];
    expect(root.querySelector(".customSchema")).toBe(null);
    expect(root.querySelector(".customHint")).toBe(null);
    expect(root.querySelector(".customInput")).not.toBe(null);
  });

  it("remounts the right body for every question type while stepping", () => {
    // Regression: the stepper card must be keyed by its question — a
    // QuestionBody picks its widget at creation, so an unkeyed card kept
    // question 1's single-choice body for every later step (multi-select
    // behaved single-select, and reaching the option-less numericRange
    // question crashed in optionCount).
    const el = mount(SAMPLES.public);
    const root = shadow(el);
    const next = () => click(root, ".stepperNav .stepNavBtn:last-child");
    const has = (selector: string, step: string) =>
      expect(
        root.querySelector(selector),
        `expected ${selector} at the ${step} step`,
      ).not.toBe(null);

    has(".radio", "singleChoice");
    next();
    has(".checkbox", "multiSelect");
    // The sample allows no selection: "None of these" is the last row, and
    // picking an option after it replaces it.
    const rows = root.querySelectorAll<HTMLElement>(".optionRow");
    rows[rows.length - 1]!.click();
    expect(root.querySelectorAll(".optionRowOn").length).toBe(1);
    // Multi-select means two clicks leave two options selected.
    rows[0]!.click();
    rows[1]!.click();
    expect(root.querySelectorAll(".optionRowOn").length).toBe(2);
    next();
    has(".rankPool", "ranking");
    next();
    has(".rangeFull", "numericRange"); // crashed here before the fix
    next();
    has(".pointsRow", "pointsAllocation");
    next();
    has(".ratingRow", "rating");
    next();
    has(".customInput", "custom");
    expect(
      root.querySelector<HTMLButtonElement>(
        ".stepperNav .stepNavBtn:last-child",
      )!.disabled,
    ).toBe(true);
    // Stepping back re-finds the draft: both multi-select picks still on.
    for (let i = 0; i < 5; i++)
      click(root, ".stepperNav .stepNavBtn:first-child");
    has(".checkbox", "multiSelect (revisited)");
    expect(root.querySelectorAll(".optionRowOn").length).toBe(2);
  });

  it("steps on after a skip, and stays on a skip taken back", () => {
    const el = mount(SAMPLES.public);
    const root = shadow(el);
    const step = () => root.querySelector(".stepCount")?.textContent;
    click(root, ".optionRow");
    click(root, ".stepperNav .stepNavBtn:last-child");
    click(root, ".skipBtn");
    expect(step()).toBe("Question 3 of 7");
    expect(root.activeElement).toBe(root.querySelector(".qPrompt"));

    click(root, ".stepperNav .stepNavBtn:first-child");
    click(root, ".skipBtn"); // "Skipped", taken back
    expect(step()).toBe("Question 2 of 7");
    expect(root.querySelector(".skipBtnOn")).toBe(null);

    for (let q = 2; q <= 7; q++) click(root, ".skipBtn");
    expect(step()).toBe("Question 7 of 7");
    expect(root.activeElement).toBe(root.querySelector(".submitBtn"));
  });

  it("moves focus to the next prompt after a skip in the list layout", () => {
    const el = mount(SAMPLES.public, { layout: "list" });
    const root = shadow(el);
    click(root, ".optionRow");
    const skips = [...root.querySelectorAll<HTMLElement>(".skipBtn")];
    skips[0]!.click(); // question 2's
    expect(root.activeElement).toBe(root.querySelectorAll(".qPrompt")[2]);
    for (const skip of skips.slice(1)) skip.click();
    expect(root.activeElement).toBe(root.querySelector(".submitBtn"));
  });

  it("moves focus to the new prompt on Next and Previous", () => {
    const root = shadow(mount(SAMPLES.public));
    click(root, ".stepperNav .stepNavBtn:last-child");
    expect(root.querySelector(".stepCount")?.textContent).toBe(
      "Question 2 of 7",
    );
    expect(root.activeElement).toBe(root.querySelector(".qPrompt"));
    click(root, ".stepperNav .stepNavBtn:first-child");
    expect(root.activeElement).toBe(root.querySelector(".qPrompt"));
  });

  it("answers choices through native inputs named by the prompt", () => {
    const root = shadow(mount(SAMPLES.public));
    const prompt = root.querySelector(".qPrompt")!;
    const group = root.querySelector('[role="radiogroup"]')!;
    expect(prompt.id).not.toBe("");
    expect(group.getAttribute("aria-labelledby")).toBe(prompt.id);
    const radios = [
      ...root.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
    ];
    expect(new Set(radios.map((r) => r.name)).size).toBe(1);
    click(root, ".optionRow");
    expect(radios.map((r) => r.checked)).toEqual([true, false, false]);

    // Up to 2 of 4: the third pick is refused, and its box stays unchecked.
    click(root, ".stepperNav .stepNavBtn:last-child");
    const rows = root.querySelectorAll<HTMLElement>(".optionRow");
    for (const i of [0, 1, 2]) rows[i]!.click();
    const boxes = root.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect([...boxes].map((b) => b.checked)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(root.querySelectorAll(".optionRowOn").length).toBe(2);
  });

  it("clears a rating by clicking its level again, or with Delete", () => {
    const root = shadow(mount(SAMPLES.public));
    for (let i = 0; i < 5; i++)
      click(root, ".stepperNav .stepNavBtn:last-child");
    // One radio group per rated item, named by the item.
    const groups = root.querySelectorAll('[role="radiogroup"]');
    expect(groups.length).toBe(2);
    expect(
      root.getElementById(groups[0]!.getAttribute("aria-labelledby")!)
        ?.textContent,
    ).toBe("Proposal A");
    const levels = groups[0]!.querySelectorAll<HTMLElement>(".ratingBtn");
    const inputs = groups[0]!.querySelectorAll<HTMLInputElement>("input");
    const on = () => root.querySelectorAll(".ratingBtnOn").length;

    levels[2]!.click();
    expect(on()).toBe(1);
    expect(inputs[2]!.checked).toBe(true);
    levels[2]!.click();
    expect(on()).toBe(0);
    expect(inputs[2]!.checked).toBe(false);

    levels[1]!.click();
    expect(on()).toBe(1);
    inputs[1]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Delete", bubbles: true }),
    );
    expect(on()).toBe(0);
  });

  it("keeps the focus in a ranking as items move between the lists", () => {
    const root = shadow(mount(SAMPLES.public));
    for (let i = 0; i < 2; i++)
      click(root, ".stepperNav .stepNavBtn:last-child");
    const pool = () => [...root.querySelectorAll<HTMLElement>(".poolBtn")];
    const rows = () => [...root.querySelectorAll<HTMLElement>(".rankedRow")];
    const removeOf = (row: number) =>
      rows()[row]!.querySelector<HTMLElement>(".rankBtnDanger")!;
    // A browser focuses the button it clicks; happy-dom doesn't.
    const press = (button: HTMLElement) => {
      button.focus();
      button.click();
    };

    // An added item's place in the pool goes to the next one, else the one
    // before, else the item's own button in the ranking.
    press(pool()[0]!); // Decentralization
    expect(root.activeElement?.textContent).toContain("Sustainability");
    press(pool()[1]!); // Usability, the last
    expect(root.activeElement?.textContent).toContain("Sustainability");
    press(pool()[0]!); // Sustainability, emptying the pool
    expect(root.activeElement).toBe(removeOf(2));

    // A moved item keeps the focus on the button that moved it.
    const up = rows()[2]!.querySelector<HTMLElement>(".rankBtn")!;
    press(up);
    expect(rows()[1]!.textContent).toContain("Sustainability");
    expect(root.activeElement).toBe(up);

    // A removed item's place goes to the item now in it, and the last one
    // back to the pool.
    press(removeOf(0));
    expect(root.activeElement).toBe(removeOf(0));
    press(removeOf(1));
    expect(root.activeElement).toBe(removeOf(0));
    press(removeOf(0));
    expect(root.activeElement?.textContent).toContain("Sustainability");
    expect(rows().length).toBe(0);
  });

  it("picks, toggles and ranks options by their letter keys", () => {
    const root = shadow(mount(SAMPLES.public));
    const prompt = () => root.querySelector<HTMLElement>(".qPrompt")!;
    const on = () =>
      [...root.querySelectorAll(".optionRowOn > span:last-of-type")].map(
        (s) => s.textContent,
      );
    const badges = () =>
      [...root.querySelectorAll(".keyBadge")].map((b) => b.textContent);
    expect(root.querySelector(".card")!.classList.contains("keysOn")).toBe(
      true,
    );
    expect(badges().slice(0, 3)).toEqual(["A", "B", "C"]);

    // From the prompt, a letter picks and the focus stays.
    prompt().focus();
    keydown(prompt(), "b");
    expect(on()).toEqual(["Governance polish"]);
    expect(root.activeElement).toBe(prompt());
    keydown(prompt(), "a", { ctrlKey: true });
    keydown(prompt(), "d");
    expect(on()).toEqual(["Governance polish"]);
    // A Cyrillic layout types ф on the key that bears A.
    keydown(prompt(), "ф", { code: "KeyA" });
    expect(on()).toEqual(["Scaling (Leios)"]);
    // Safari's click on an option focuses the card instead, if it can.
    const card = root.querySelector<HTMLElement>(".card")!;
    expect(card.getAttribute("tabindex")).toBe("-1");
    keydown(card, "b");
    expect(on()).toEqual(["Governance polish"]);
    // In the group, the focus goes with the check.
    const radios = root.querySelectorAll<HTMLInputElement>(".choiceInput");
    radios[0]!.focus();
    keydown(radios[0]!, "C");
    expect(on()).toEqual(["Developer tooling"]);
    expect(root.activeElement).toBe(radios[2]);

    // Up to 2 of 4, and the None box takes E.
    keydown(radios[2]!, "Enter");
    expect(badges().slice(0, 6)).toEqual([
      "A",
      "B",
      "C",
      "D",
      "E",
      "⇧ Enter ↵",
    ]);
    for (const k of ["a", "c", "d"]) keydown(prompt(), k);
    expect(on()).toEqual(["Core protocol", "Education"]);
    keydown(prompt(), "a", { repeat: true }); // held down
    expect(on()).toEqual(["Core protocol", "Education"]);
    keydown(prompt(), "e");
    expect(on()).toEqual(["None of these"]);

    // Typing C A ranks them in that order, from the prompt.
    keydown(prompt(), "Enter");
    keydown(prompt(), "c");
    keydown(prompt(), "a");
    expect(
      [...root.querySelectorAll(".rankLabel")].map((l) => l.textContent),
    ).toEqual(["Usability", "Decentralization"]);
    expect(
      [...root.querySelectorAll(".poolBtn .keyBadge")].map(
        (b) => b.textContent,
      ),
    ).toEqual(["B"]);
    expect(root.activeElement).toBe(prompt());

    keydown(prompt(), "Enter", { shiftKey: true });
    expect(root.querySelector(".stepCount")?.textContent).toBe(
      "Question 2 of 7",
    );
    expect(root.activeElement).toBe(prompt());
  });

  it("rates by digit the item holding the focus, or the only one", () => {
    const root = shadow(mount(SAMPLES.public));
    for (let i = 0; i < 5; i++)
      click(root, ".stepperNav .stepNavBtn:last-child");
    const prompt = root.querySelector<HTMLElement>(".qPrompt")!;
    const on = () =>
      [...root.querySelectorAll(".ratingBtnOn")].map((b) => b.textContent);
    // Two items: from the prompt a digit rates neither.
    keydown(prompt, "3");
    expect(on()).toEqual([]);
    const second = root.querySelectorAll('[role="radiogroup"]')[1]!;
    const inputs = second.querySelectorAll<HTMLInputElement>("input");
    inputs[0]!.focus();
    keydown(inputs[0]!, "3");
    expect(on()).toEqual(["Good"]);
    expect(inputs[2]!.checked).toBe(true);
    expect(root.activeElement).toBe(inputs[2]);
    keydown(inputs[2]!, "5"); // a four-level scale
    expect(on()).toEqual(["Good"]);
    // Safari's click on a level focuses its group instead, if it can.
    const first = root.querySelector<HTMLElement>('[role="radiogroup"]')!;
    expect(first.getAttribute("tabindex")).toBe("-1");
    keydown(first, "2");
    expect(on()).toEqual(["Fair", "Good"]);

    // A scale of numbers takes the digit it shows; the only item takes it
    // from the prompt.
    document.body.innerHTML = "";
    const root2 = shadow(
      mount({
        ...oneQuestionDef({ type: "public" }),
        questions: [
          {
            type: "rating",
            prompt: "Rate it",
            requireAll: true,
            scale: { type: "numeric", constraints: { min: 0n, max: 4n } },
            options: { type: "options", labels: ["The plan"] },
          },
        ],
      }),
    );
    keydown(root2.querySelector(".qPrompt")!, "0");
    expect(root2.querySelector(".ratingBtnOn")?.textContent).toBe("0");
  });

  it("moves on with Enter, but not from a button or in a text area", () => {
    const root = shadow(mount(SAMPLES.public, { layout: "list" }));
    const prompts = [...root.querySelectorAll<HTMLElement>(".qPrompt")];
    prompts[0]!.focus();
    keydown(prompts[0]!, "Enter");
    expect(root.activeElement).toBe(prompts[1]);
    keydown(prompts[1]!, "Enter", { shiftKey: true });
    expect(root.activeElement).toBe(prompts[0]);
    keydown(prompts[0]!, "Enter", { shiftKey: true });
    expect(root.activeElement).toBe(prompts[0]);

    const skip = root.querySelector<HTMLElement>(".skipBtn")!;
    skip.focus();
    expect(keydown(skip, "Enter").defaultPrevented).toBe(false);
    expect(root.activeElement).toBe(skip);
    // A skipped question takes no letter.
    skip.click();
    keydown(prompts[1]!, "a");
    skip.click();
    expect(
      root.querySelectorAll(".card")[1]!.querySelector(".optionRowOn"),
    ).toBe(null);

    // The last question's text area: Enter is a line break, Ctrl or Cmd
    // with it moves on to the submit button, and with Shift goes back.
    click(root, ".optionRow");
    for (const s of [...root.querySelectorAll<HTMLElement>(".skipBtn")].slice(
      0,
      5,
    ))
      s.click();
    const text = root.querySelector<HTMLTextAreaElement>(".customInput")!;
    text.value = "More docs";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    text.focus();
    expect(keydown(text, "Enter").defaultPrevented).toBe(false);
    expect(root.activeElement).toBe(text);
    keydown(text, "Enter", { metaKey: true });
    expect(root.activeElement).toBe(root.querySelector(".submitBtn"));
    keydown(text, "Enter", { ctrlKey: true, shiftKey: true });
    expect(root.activeElement).toBe(prompts[5]);
  });

  it("leaves every key to the host with keyboardShortcuts false", () => {
    const check = (el: TesseraRespondElement) => {
      const root = shadow(el);
      const prompt = root.querySelector<HTMLElement>(".qPrompt")!;
      expect(root.querySelector(".keysOn")).toBe(null);
      expect(keydown(prompt, "a").defaultPrevented).toBe(false);
      expect(keydown(prompt, "Enter").defaultPrevented).toBe(false);
      expect(root.querySelector(".optionRowOn")).toBe(null);
      expect(root.querySelector(".stepCount")?.textContent).toBe(
        "Question 1 of 7",
      );
    };
    check(mount(SAMPLES.public, { keyboardShortcuts: false }));
    document.body.innerHTML = `<tessera-respond keyboard-shortcuts="false"></tessera-respond>`;
    const el = document.body.querySelector("tessera-respond")!;
    Object.assign(el, {
      definition: SAMPLES.public,
      surveyRef: SURVEY_REFS.public,
      responder,
      tipEpoch: TIP_EPOCH,
    });
    check(el);
  });

  it("upgrades from HTML markup, waits for props, and honors attributes", () => {
    document.body.innerHTML = `<tessera-respond locale="fr"></tessera-respond>`;
    const el = document.body.querySelector("tessera-respond")!;
    // Connected without data: nothing rendered, no crash.
    expect(shadow(el).querySelector(".root")).toBe(null);
    el.definition = SAMPLES.public;
    el.surveyRef = SURVEY_REFS.public;
    el.responder = responder;
    el.tipEpoch = TIP_EPOCH;
    // Now rendered — in French, from the plain `locale` attribute.
    expect(shadow(el).querySelector(".roleRowLabel")?.textContent).toBe(
      "Vous répondez en tant que",
    );
  });

  it("emits tessera:change across the shadow boundary as answers land", async () => {
    const el = mount(oneQuestionDef({ type: "public" }));
    const changed = once(el, "tessera:change");
    click(shadow(el), ".optionRow");
    const e = await changed;
    expect(e.detail).toEqual({
      decided: 1,
      total: 1,
      unanswered: [],
      unseen: [],
      unfinished: [],
      required: [],
      valid: true,
    });
  });

  it("says what is left beside the submit button, each question a link", () => {
    const el = mount(SAMPLES.public);
    const root = shadow(el);
    const left = () => root.querySelector(".leftNote")?.textContent?.trim();
    expect(left()).toBe("Required: Q1 6 not seen yet. First: Q2");

    click(root, ".optionRow");
    expect(left()).toBe("6 not seen yet. First: Q2");
    click(root, ".leftNote .qLink");
    expect(root.querySelector(".stepCount")?.textContent).toBe(
      "Question 2 of 7",
    );
    expect(root.activeElement).toBe(root.querySelector(".qPrompt"));

    click(root, ".skipBtn");
    expect(left()).toBe("Not seen yet: Q4 · Q5 · Q6 · Q7 Not answered yet: Q3");
  });

  it("stops at the first required or unfinished question, sending nothing", () => {
    const el = mount(SAMPLES.public, { layout: "list", maxTextBytes: 4 });
    const root = shadow(el);
    let sent = false;
    el.addEventListener("tessera:response", () => (sent = true));
    const text = root.querySelector<HTMLTextAreaElement>(".customInput")!;
    text.value = "Too long";
    text.dispatchEvent(new Event("input", { bubbles: true }));
    expect(root.querySelector(".leftNote")?.textContent?.trim()).toBe(
      "Required: Q1 Not finished: Q7 Not answered yet: Q2 · Q3 · Q4 · Q5 · Q6",
    );
    const prompts = root.querySelectorAll(".qPrompt");

    click(root, ".submitBtn");
    expect(root.activeElement).toBe(prompts[0]);
    click(root, ".optionRow");
    click(root, ".submitBtn");
    expect(root.activeElement).toBe(prompts[6]);
    expect(sent).toBe(false);
  });

  it("asks before skipping the questions seen and left unanswered", async () => {
    onScreen = false;
    const el = mount(SAMPLES.public, { layout: "list" });
    const root = shadow(el);
    const rows = root.querySelectorAll<HTMLElement>(".optionRow");
    rows[0]!.click();
    click(root, ".submitBtn");
    expect(root.querySelector(".skipConfirm")).toBe(null);
    expect(root.activeElement).toBe(root.querySelectorAll(".qPrompt")[1]);

    onScreen = true;
    scrolled();
    click(root, ".submitBtn");
    const ask = root.querySelector(".skipConfirmText");
    expect(ask?.textContent).toBe(
      "6 questions have no answer: Q2 · Q3 · Q4 · Q5 · Q6 …",
    );
    expect(root.activeElement).toBe(ask);
    expect(root.querySelector(".submitBtn")).toBe(null);

    // Any edit closes it, and so does a step.
    rows[1]!.click();
    expect(root.querySelector(".skipConfirm")).toBe(null);
    click(root, ".submitBtn");
    click(root, ".goToBtn");
    expect(root.querySelector(".skipConfirm")).toBe(null);
    expect(root.activeElement).toBe(root.querySelectorAll(".qPrompt")[1]);

    click(root, ".submitBtn");
    const responded = once(el, "tessera:response");
    click(root, ".skipFinishBtn");
    const payload = decodePayload(
      ((await responded).detail as RespondResult).payload,
    );
    if (payload.type !== "responses") throw new Error("not a response");
    const answers = payload.responses[0]!.answers;
    if (answers.type !== "public") throw new Error("not public");
    expect(answers.answers).toEqual([
      { type: "singleChoice", questionIndex: 0, optionIndex: 1 },
    ]);
    expect(root.querySelectorAll(".skipBtnOn").length).toBe(6);
  });

  it("asks for one answer when there is nothing to send", () => {
    const def = oneQuestionDef({ type: "public" });
    const el = mount({
      ...def,
      questions: [{ ...def.questions[0]!, required: false }],
    });
    const root = shadow(el);
    const left = () => root.querySelector(".leftNote")?.textContent;
    click(root, ".submitBtn");
    expect(left()).toBe("Answer at least one question to finish.");
    click(root, ".skipBtn");
    expect(left()).toBe("Answer at least one question to finish.");
    click(root, ".skipBtn");
    click(root, ".optionRow");
    expect(left()).toBe("All questions answered or skipped.");
  });

  it("emits a decodable public payload on submit", async () => {
    const def = oneQuestionDef({ type: "public" });
    const el = mount(def);
    const root = shadow(el);
    click(root, ".optionRow");
    const responded = once(el, "tessera:response");
    click(root, ".submitBtn");
    const detail = (await responded).detail as RespondResult;

    expect(detail.sealed).toBe(false);
    expect(detail.role).toBe(Role.Keyholder);
    expect(detail.proveCredentials).toHaveLength(1);
    expect(detail.proveCredentials[0]!.keyKind).toBe("payment");
    expect(detail.surveyRef).toEqual(SURVEY_REFS.public);

    // The payload is the final label-17 metadatum: decode it back and check
    // the response validates against the definition it was built for.
    const payload = decodePayload(detail.payload);
    expect(payload.type).toBe("responses");
    if (payload.type !== "responses") return;
    expect(payload.responses).toHaveLength(1);
    expect(validateResponse(def, payload.responses[0]!)).toEqual([]);
  });

  it("shows the cancelled notice when the host flags cancellation", () => {
    // Cancellation is an on-chain fact only the host can observe (a tag-2
    // message) — it arrives via the `cancelled` prop, not `surveyStatus`.
    const el = mount(SAMPLES.public, { cancelled: true });
    const root = shadow(el);
    expect(root.querySelector(".noticeTitle")?.textContent).toBe(
      "This survey was cancelled",
    );
    expect(root.querySelector(".card")).toBe(null);
    expect(root.querySelector(".submitBtn")).toBe(null);
  });

  it("treats a bare `cancelled` attribute as cancelled (HTML boolean style)", () => {
    // component-register parses a valueless attribute to `undefined`; without
    // the wrapper's hasAttribute fallback this idiomatic form failed *open*,
    // rendering the survey answerable.
    document.body.innerHTML = `<tessera-respond cancelled></tessera-respond>`;
    const el = document.body.querySelector("tessera-respond")!;
    el.definition = SAMPLES.public;
    el.surveyRef = SURVEY_REFS.public;
    el.responder = responder;
    el.tipEpoch = TIP_EPOCH;
    const root = shadow(el);
    expect(root.querySelector(".noticeTitle")?.textContent).toBe(
      "This survey was cancelled",
    );
    expect(root.querySelector(".submitBtn")).toBe(null);
  });

  it("survives the host swapping the definition to a new question shape mid-edit", () => {
    const def = oneQuestionDef({ type: "public" });
    const el = mount(def);
    const root = shadow(el);
    click(root, ".optionRow"); // touch → reseeding is now gated off
    // Re-set the definition with a *different question type*: the stale
    // singleChoice draft renders against a multiSelect question. QuestionBody
    // falls back to a fresh initial value instead of crashing on the cast.
    el.definition = {
      ...def,
      questions: [
        {
          type: "multiSelect",
          prompt: "Pick some",
          required: true,
          options: { type: "options", labels: ["A", "B"] },
          minSelections: 1,
          maxSelections: 2,
        },
      ],
    } as SurveyDefinition;
    expect(root.querySelector(".checkbox")).not.toBe(null);
    expect(root.querySelectorAll(".optionRowOn").length).toBe(0);
  });

  it("keeps the answers when the host swaps the wallet behind the role", () => {
    const el = mount(oneQuestionDef({ type: "public" }));
    const root = shadow(el);
    click(root, ".optionRow");
    el.responder = {
      [Role.Keyholder]: { type: "key", keyHash: hexToBytes("ee".repeat(28)) },
    };
    expect(root.querySelectorAll(".optionRowOn").length).toBe(1);
  });

  it("keeps answers in a host stash across elements, under the survey key", () => {
    // A stash that holds only JSON text, as localStorage would.
    const kept = new Map<string, string>();
    const stash = {
      get: (k: string) => {
        const json = kept.get(k);
        return json === undefined ? undefined : JSON.parse(json);
      },
      set: (k: string, form: unknown) => void kept.set(k, JSON.stringify(form)),
      delete: (k: string) => void kept.delete(k),
    };
    const def = oneQuestionDef({ type: "public" });
    click(shadow(mount(def, { stash })), ".optionRow");
    document.body.innerHTML = "";

    const el = mount(def, { stash });
    const root = shadow(el);
    expect(root.querySelectorAll(".optionRowOn").length).toBe(1);
    expect([...kept.keys()]).toEqual([refKey(SURVEY_REFS.public)]);
  });

  it("shows the survey's translated text, and a locale switch keeps the form", () => {
    const fr = TRANSLATIONS.translations!.fr!;
    const el = mount(SAMPLES.public, { translations: TRANSLATIONS });
    const root = shadow(el);
    const text = (selector: string) =>
      root.querySelector(selector)?.textContent;
    expect(text(".qPrompt")).toBe(SAMPLES.public.questions[0]!.prompt);

    click(root, ".optionRow");
    click(root, ".stepperNav .stepNavBtn:last-child");
    el.locale = "fr-CA";
    expect(text(".headerDesc")).toBe(fr.description);
    expect(text(".headerTitle")).toBe(SAMPLES.public.title);
    expect(text(".qPrompt")).toBe(fr.questions![1]!.prompt);
    click(root, ".stepperNav .stepNavBtn:first-child");
    expect(text(".qPrompt")).toBe(fr.questions![0]!.prompt);
    expect(text(".optionRowOn > span:last-of-type")).toBe(
      fr.questions![0]!.options![0],
    );
    expect(root.querySelectorAll(".optionRowOn").length).toBe(1);
  });

  it("words the None box in the survey's own text, translated by locale", () => {
    const el = mount(SAMPLES.public, {
      layout: "list",
      noneLabels: NONE_LABELS,
      translations: TRANSLATIONS,
    });
    const root = shadow(el);
    const noneBox = () =>
      root
        .querySelectorAll(".card")[1]!
        .querySelector(".multiGrid > :last-child > span:last-of-type")!
        .textContent;
    expect(noneBox()).toBe(NONE_LABELS[1]);
    el.locale = "fr";
    expect(noneBox()).toBe(
      TRANSLATIONS.translations!.fr!.questions![1]!.noneLabel,
    );
    el.translations = undefined;
    el.noneLabels = undefined;
    expect(noneBox()).toBe("Aucune de celles-ci");
  });

  it("drops a None label on a question without a None box, with a warning", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = mount(SAMPLES.public, {
      layout: "list",
      noneLabels: { ...NONE_LABELS, 0: "Neither" },
    });
    const root = shadow(el);
    expect(root.querySelectorAll(".card")[1]!.textContent).toContain(
      NONE_LABELS[1],
    );
    expect(root.querySelectorAll(".card")[0]!.textContent).not.toContain(
      "Neither",
    );
    expect(warn).toHaveBeenCalledWith(
      "tessera-respond: noneLabels: question 0 is not a multi-select with a minimum of 0",
    );
    warn.mockRestore();
  });

  it("shows a question only while its condition holds", () => {
    const el = mount(SAMPLES.public, {
      layout: "list",
      conditions: CONDITIONS,
    });
    const root = shadow(el);
    const cards = () => root.querySelectorAll(".card").length;
    const hiddenChips = () =>
      [...root.querySelectorAll(".hiddenRow .qChip")].map((c) => c.textContent);
    const rowsOf = (card: number) =>
      root
        .querySelectorAll(".card")
        [card]!.querySelectorAll<HTMLElement>(".optionRow");
    // Nothing picked yet: the ranking (anyOf) hides, the points (noneOf) show.
    expect(cards()).toBe(6);
    expect(hiddenChips()).toEqual(["Q3"]);
    rowsOf(0)[1]!.click(); // "Governance polish" shows the ranking
    expect(cards()).toBe(7);
    expect(hiddenChips()).toEqual([]);
    rowsOf(1)[3]!.click(); // "Marketing" hides the points allocation
    expect(cards()).toBe(6);
    expect(hiddenChips()).toEqual(["Q5"]);
    expect(root.querySelector(".noticeWarn")).toBe(null);
  });

  it("tells the None box from a skip", () => {
    const el = mount(SAMPLES.public, {
      layout: "list",
      conditions: CONDITIONS,
    });
    const root = shadow(el);
    const hiddenChips = () =>
      [...root.querySelectorAll(".hiddenRow .qChip")].map((c) => c.textContent);
    const funding = () => root.querySelectorAll(".card")[1]!;
    const skip = () =>
      funding().querySelector<HTMLElement>(".skipBtn")!.click();
    const none = () =>
      [...funding().querySelectorAll<HTMLElement>(".optionRow")]
        .at(-1)!
        .click();
    skip(); // the treasury cut (noneOf "none") stays
    expect(hiddenChips()).toEqual(["Q3"]);
    skip();
    none();
    expect(hiddenChips()).toEqual(["Q3", "Q4"]);
    none();
    expect(hiddenChips()).toEqual(["Q3"]);
  });

  it("steps over a hidden question, and leaves it out of the payload", async () => {
    const el = mount(SAMPLES.public, { conditions: CONDITIONS });
    const root = shadow(el);
    click(root, ".optionRow"); // "Scaling", so the ranking stays hidden
    click(root, ".stepperNav .stepNavBtn:last-child");
    click(root, ".stepperNav .stepNavBtn:last-child");
    expect(root.querySelector(".rangeFull")).not.toBe(null);
    expect(root.querySelector(".stepCount")?.textContent).toBe(
      "Question 4 of 7",
    );

    el.layout = "list";
    for (const skip of root.querySelectorAll<HTMLElement>(".skipBtn"))
      skip.click();
    expect(root.querySelectorAll(".progressDotOn").length).toBe(1);
    expect(root.querySelectorAll(".progressDotSkipped").length).toBe(6);

    const responded = once(el, "tessera:response");
    click(root, ".submitBtn");
    const payload = decodePayload(
      ((await responded).detail as RespondResult).payload,
    );
    if (payload.type !== "responses") throw new Error("not a response");
    const answers = payload.responses[0]!.answers;
    if (answers.type !== "public") throw new Error("not public");
    expect(answers.answers.map((a) => a.questionIndex)).toEqual([0]);
  });

  it("applies no condition when one is faulty, and says so", () => {
    const el = mount(SAMPLES.public, {
      layout: "list",
      conditions: { ...CONDITIONS, 1: { question: 3, anyOf: [0] } },
    });
    const root = shadow(el);
    expect(root.querySelectorAll(".card").length).toBe(7);
    expect(root.querySelector(".noticeWarn .noticeTitle")?.textContent).toBe(
      "Every question is shown",
    );
  });

  it("keeps in-progress answers when switching role", () => {
    const def: SurveyDefinition = {
      ...oneQuestionDef({ type: "public" }),
      eligibleRoles: [Role.DRep, Role.Stakeholder],
    };
    const el = mount(def);
    const root = shadow(el);
    const pickRole = (label: string): void => {
      const btn = [
        ...root.querySelectorAll<HTMLButtonElement>(".rolePick"),
      ].find((b) => b.textContent === label);
      expect(btn, `a ${label} role button`).not.toBe(undefined);
      btn!.click();
    };
    click(root, ".optionRow"); // answer as DRep (first respondable)
    pickRole("Stakeholder"); // a correction: the answers come along
    expect(root.querySelectorAll(".optionRowOn").length).toBe(1);
  });

  it("honors the initial-role preference (property or attribute)", () => {
    const def: SurveyDefinition = {
      ...oneQuestionDef({ type: "public" }),
      eligibleRoles: [Role.DRep, Role.Stakeholder],
    };
    // Property form.
    const el = mount(def, { initialRole: Role.Stakeholder });
    expect(shadow(el).querySelector(".rolePickOn")?.textContent).toBe(
      "Stakeholder",
    );
    // Attribute form (Stakeholder = 3), parsed by the hyphenated alias.
    document.body.innerHTML = `<tessera-respond initial-role="3"></tessera-respond>`;
    const el2 = document.body.querySelector("tessera-respond")!;
    el2.definition = def;
    el2.surveyRef = SURVEY_REFS.public;
    el2.responder = responder;
    el2.tipEpoch = TIP_EPOCH;
    expect(shadow(el2).querySelector(".rolePickOn")?.textContent).toBe(
      "Stakeholder",
    );
  });

  it("hides the role row when showRole is false (property or attribute)", () => {
    const def: SurveyDefinition = {
      ...oneQuestionDef({ type: "public" }),
      eligibleRoles: [Role.DRep, Role.Stakeholder],
    };
    const el = mount(def);
    expect(shadow(el).querySelector(".roleRow")).not.toBe(null);
    el.showRole = false;
    expect(shadow(el).querySelector(".roleRow")).toBe(null);
    document.body.innerHTML = `<tessera-respond show-role="false" initial-role="3"></tessera-respond>`;
    const el2 = document.body.querySelector("tessera-respond")!;
    el2.definition = def;
    el2.surveyRef = SURVEY_REFS.public;
    el2.responder = responder;
    el2.tipEpoch = TIP_EPOCH;
    expect(shadow(el2).querySelector(".roleRow")).toBe(null);
  });

  it("adopts the stylesheet once even when the host moves the element", async () => {
    // component-register re-initializes the whole component on a true
    // disconnect + reconnect, but the shadow root (and its adopted styles)
    // survives — the sheet must not stack up.
    const el = mount(SAMPLES.public);
    const styleCount = (): number =>
      shadow(el).adoptedStyleSheets.length +
      shadow(el).querySelectorAll("style").length;
    const before = styleCount();
    expect(before).toBeGreaterThan(0);
    el.remove();
    // disconnectedCallback releases asynchronously; let it settle.
    await new Promise((r) => setTimeout(r));
    document.body.appendChild(el);
    expect(shadow(el).querySelector(".root")).not.toBe(null); // re-initialized
    expect(styleCount()).toBe(before);
  });

  it("answers as SPO from a host-supplied credential, wallet-free", async () => {
    // Proving credentials is out of the widget's scope — a host that vouches
    // for an SPO credential (just an entry in the responder map, even with no
    // wallet-derived roles at all) gets the full answering flow, and the
    // credential comes back in `proveCredentials` for the host to prove.
    const spoCred = {
      type: "key",
      keyHash: hexToBytes("dd".repeat(28)),
    } as const;
    const def: SurveyDefinition = {
      ...oneQuestionDef({ type: "public" }),
      eligibleRoles: [Role.SPO],
    };
    const el = mount(def, {
      responder: { [Role.SPO]: spoCred },
    });
    const root = shadow(el);
    click(root, ".optionRow");
    const responded = once(el, "tessera:response");
    click(root, ".submitBtn");
    const detail = (await responded).detail as RespondResult;

    expect(detail.role).toBe(Role.SPO);
    expect(detail.credential).toEqual(spoCred);
    expect(detail.proveCredentials).toEqual([
      { credential: spoCred, keyKind: "pool" },
    ]);
    expect(decodePayload(detail.payload).type).toBe("responses");
  });

  it("prefills the prior response for whichever role a multi-role responder picks", () => {
    // A responder eligible in several roles switches between them inside the
    // widget, so the host can't know up front which prior response applies. It
    // hands over one per role (`priorResponses`) and the widget selects by the
    // chosen role — the fix for the singular prop, which could only prefill one.
    const def: SurveyDefinition = {
      ...oneQuestionDef({ type: "public" }),
      eligibleRoles: [Role.DRep, Role.Stakeholder],
    };
    // A prior response per role, answering the one question differently:
    // DRep → "First" (0), Stakeholder → "Second" (1). `responder` is the
    // role→credential map, so index it for each role's credential.
    const prior = (role: Role, optionIndex: number) =>
      buildResponse(SURVEY_REFS.public, role, responder[role]!, def.questions, [
        { skipped: false, value: { type: "singleChoice", optionIndex } },
      ]);
    const el = mount(def, {
      // Order irrelevant — the widget matches by role, not position.
      priorResponses: [prior(Role.Stakeholder, 1), prior(Role.DRep, 0)],
    });
    const root = shadow(el);

    const onIndex = (): number =>
      [...root.querySelectorAll(".optionRow")].findIndex((r) =>
        r.classList.contains("optionRowOn"),
      );
    // Default role is the first respondable (DRep) → its "First" is prefilled.
    expect(onIndex()).toBe(0);

    // Switch to Stakeholder via the header role picker → reprefills "Second".
    const stakeBtn = [
      ...root.querySelectorAll<HTMLButtonElement>(".rolePick"),
    ].find((b) => b.textContent === "Stakeholder");
    expect(stakeBtn, "a Stakeholder role button").not.toBe(undefined);
    stakeBtn!.click();
    expect(onIndex()).toBe(1);
  });

  it("lazy-loads the sealed chunks and emits a real ciphertext", async () => {
    const paddingSize = 512;
    const def = oneQuestionDef({
      type: "sealed",
      chainHash: QUICKNET_CHAIN_HASH,
      round: 45_000_000,
      paddingSize,
    });
    const el = mount(def);
    const root = shadow(el);
    expect(root.querySelector(".cardBanner")).not.toBe(null); // sealed banner
    click(root, ".optionRow");
    const responded = once(el, "tessera:response");
    click(root, ".submitBtn"); // "Encrypt & submit" → dynamic import()s fire
    const detail = (await responded).detail as RespondResult;

    expect(detail.sealed).toBe(true);
    const payload = decodePayload(detail.payload);
    expect(payload.type).toBe("responses");
    if (payload.type !== "responses") return;
    const response = payload.responses[0]!;
    expect(validateResponse(def, response)).toEqual([]);
    // A real (padded) tlock ciphertext, not a placeholder.
    expect(response.answers.type).toBe("sealed");
    if (response.answers.type !== "sealed") return;
    expect(response.answers.ciphertext.length).toBeGreaterThanOrEqual(
      paddingSize,
    );
  });
});
