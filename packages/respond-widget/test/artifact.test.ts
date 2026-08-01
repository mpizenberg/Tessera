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
import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  Role,
  SPEC_VERSION,
  decodePayload,
  validateResponse,
  type SubmissionMode,
  type SurveyDefinition,
} from "cip-179";
import { hexToBytes } from "cip-179/domain";
import { QUICKNET_CHAIN_HASH } from "cip-179/tlock";
import { buildResponse } from "cardano-tessera-respond-core";

import { SAMPLES, TIP_EPOCH, responder, surveyRef } from "../dev/samples";
import type { RespondResult, TesseraRespondElement } from "../src/types";

beforeAll(async () => {
  // Importing the artifact registers <tessera-respond> as a side effect.
  await import("../dist/tessera-respond.es.js");
});

afterEach(() => {
  document.body.innerHTML = "";
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
  el.surveyRef = surveyRef;
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
    // Multi-select means two clicks leave two options selected.
    const rows = root.querySelectorAll<HTMLElement>(".optionRow");
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

  it("upgrades from HTML markup, waits for props, and honors attributes", () => {
    document.body.innerHTML = `<tessera-respond locale="fr"></tessera-respond>`;
    const el = document.body.querySelector("tessera-respond")!;
    // Connected without data: nothing rendered, no crash.
    expect(shadow(el).querySelector(".root")).toBe(null);
    el.definition = SAMPLES.public;
    el.surveyRef = surveyRef;
    el.responder = responder;
    el.tipEpoch = TIP_EPOCH;
    // Now rendered — in French, from the plain `locale` attribute.
    expect(shadow(el).querySelector(".respondLabel")?.textContent).toBe(
      "Répondre",
    );
  });

  it("emits tessera:change across the shadow boundary as answers land", async () => {
    const el = mount(oneQuestionDef({ type: "public" }));
    const changed = once(el, "tessera:change");
    click(shadow(el), ".optionRow");
    const e = await changed;
    expect(e.detail).toEqual({ decided: 1, total: 1, valid: true });
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
    expect(detail.surveyRef).toEqual(surveyRef);

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
    el.surveyRef = surveyRef;
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

  it("reseeds pristine when the credential behind the current role changes", () => {
    // Form identity is (survey, role, credential): a host swapping `responder`
    // to a different wallet holding the same role must not keep wallet A's
    // edits to submit under wallet B's credential.
    const el = mount(oneQuestionDef({ type: "public" }));
    const root = shadow(el);
    click(root, ".optionRow");
    expect(root.querySelectorAll(".optionRowOn").length).toBe(1);
    el.responder = {
      [Role.Keyholder]: { type: "key", keyHash: hexToBytes("ee".repeat(28)) },
    };
    expect(root.querySelectorAll(".optionRowOn").length).toBe(0);
  });

  it("restores in-progress answers when switching back to a role", () => {
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
    pickRole("Stakeholder"); // fresh, pristine form for the other role
    expect(root.querySelectorAll(".optionRowOn").length).toBe(0);
    pickRole("DRep"); // a misclick isn't data loss: the edit is restored
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
    el2.surveyRef = surveyRef;
    el2.responder = responder;
    el2.tipEpoch = TIP_EPOCH;
    expect(shadow(el2).querySelector(".rolePickOn")?.textContent).toBe(
      "Stakeholder",
    );
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
      buildResponse(surveyRef, role, responder[role]!, def.questions, [
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
