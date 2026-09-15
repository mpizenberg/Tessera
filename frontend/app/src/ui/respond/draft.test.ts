import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import type { Question } from "cip-179";
import type { Draft } from "cardano-tessera-respond-core";

import { responseDrafts } from "./draft";
import type { RationaleInputs } from "./Rationale";

// Same shim as cart.test.ts: these tests run in plain Node, no DOM.
const store = new Map<string, string>();
const KEY = "tessera.responseDrafts.preview";

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

const options = { type: "options", labels: ["a", "b", "c"] } as const;
const questions: Question[] = [
  { type: "singleChoice", prompt: "", required: true, options },
  {
    type: "multiSelect",
    prompt: "",
    required: false,
    options,
    minSelections: 0,
    maxSelections: 3,
  },
  {
    type: "ranking",
    prompt: "",
    required: false,
    options,
    minRanked: 1,
    maxRanked: 3,
  },
  {
    type: "numericRange",
    prompt: "",
    required: false,
    constraints: { min: 0n, max: 10n ** 30n },
  },
  { type: "pointsAllocation", prompt: "", required: false, options, budget: 9 },
  {
    type: "rating",
    prompt: "",
    required: false,
    options,
    scale: { type: "numeric", constraints: { min: 1n, max: 5n } },
    requireAll: false,
  },
  {
    type: "custom",
    prompt: "",
    required: false,
    methodSchema: { uri: "ipfs://schema", hash: new Uint8Array(32) },
  },
];

const form: Draft[] = [
  { skipped: false, value: { type: "singleChoice", optionIndex: 2 } },
  { skipped: false, value: { type: "multiSelect", selected: [0, 2] } },
  { skipped: true, value: { type: "ranking", ranked: [] } },
  { skipped: false, value: { type: "numeric", value: 10n ** 30n } },
  { skipped: false, value: { type: "pointsAllocation", points: [4, 0, 5] } },
  { skipped: false, value: { type: "rating", ratings: [5n, null, 1n] } },
  { skipped: false, value: { type: "custom", text: "why not" } },
];

const rationale: RationaleInputs = {
  on: true,
  mode: "write",
  text: "Because.",
  uri: "",
  hash: "",
};

/** The kept state for one survey, with the tip movable per test. */
function surveyAt(key: string, endEpoch: number) {
  let tip: number | undefined = 100;
  const drafts = responseDrafts({
    key: () => key,
    endEpoch: () => endEpoch,
    tipEpoch: () => tip,
  });
  return { ...drafts, setTip: (epoch: number | undefined) => (tip = epoch) };
}

const FORM = "survey|0:key:ab";

describe("unsent answers survive a reload", () => {
  test("a form comes back as it was, big integers included", () => {
    surveyAt("s1", 120).stash.set(FORM, form);
    expect(surveyAt("s1", 120).stash.get(FORM, questions)).toEqual(form);
  });

  test("a number not yet chosen comes back unset", () => {
    const unset = form.map(
      (d, i): Draft =>
        i === 3 ? { ...d, value: { type: "numeric", value: null } } : d,
    );
    surveyAt("s1", 120).stash.set(FORM, unset);
    expect(surveyAt("s1", 120).stash.get(FORM, questions)).toEqual(unset);
  });

  test("a form that no longer fits its questions reads as nothing", () => {
    const s = surveyAt("s1", 120);
    const misfits: Draft[][] = [
      form.slice(1),
      form.map((d, i) =>
        i === 0 ? { ...d, value: { type: "custom", text: "2" } } : d,
      ),
      form.map((d, i) =>
        i === 0 ? { ...d, value: { type: "singleChoice", optionIndex: 3 } } : d,
      ),
      form.map((d, i) =>
        i === 1
          ? { ...d, value: { type: "multiSelect", selected: [2, 2] } }
          : d,
      ),
      form.map((d, i) =>
        i === 5 ? { ...d, value: { type: "rating", ratings: [5n, null] } } : d,
      ),
    ];
    for (const misfit of misfits) {
      s.stash.set(FORM, misfit);
      expect(s.stash.get(FORM, questions)).toBeUndefined();
    }

    // Numbers where big integers belong, as a hand edit would leave them.
    s.stash.set(FORM, form);
    const kept = JSON.parse(store.get(KEY)!) as {
      s1: { forms: Record<string, { value: { value?: unknown } }[]> };
    };
    kept.s1.forms[FORM]![3]!.value.value = 7;
    store.set(KEY, JSON.stringify(kept));
    expect(s.stash.get(FORM, questions)).toBeUndefined();
  });

  test("an ended survey's entry goes on the next write, but not while the tip is unknown", () => {
    const ended = surveyAt("old", 99);
    ended.setTip(undefined);
    ended.stash.set(FORM, form);
    const open = surveyAt("new", 120);
    open.setTip(undefined);
    open.stash.set(FORM, form);
    expect(ended.stash.get(FORM, questions)).toEqual(form);

    open.setTip(100);
    open.stash.set(FORM, form);
    expect(ended.stash.get(FORM, questions)).toBeUndefined();
    expect(open.stash.get(FORM, questions)).toEqual(form);
  });

  test("the rationale is kept per survey until it is emptied", () => {
    const s = surveyAt("s1", 120);
    s.storeRationale(rationale);
    expect(surveyAt("s1", 120).loadRationale()).toEqual(rationale);
    expect(surveyAt("s2", 120).loadRationale()).toBeUndefined();

    s.storeRationale({ ...rationale, text: "  " });
    expect(s.loadRationale()).toBeUndefined();
  });

  test("the key goes once the last form and rationale do", () => {
    const s = surveyAt("s1", 120);
    s.stash.set(FORM, form);
    s.storeRationale(rationale);
    s.stash.delete(FORM);
    expect(store.has(KEY)).toBe(true);
    s.storeRationale(undefined);
    expect(store.has(KEY)).toBe(false);
  });

  test("nothing is written before the survey's end epoch is known", () => {
    const loading = responseDrafts({
      key: () => "s1",
      endEpoch: () => undefined,
      tipEpoch: () => 100,
    });
    loading.stash.set(FORM, form);
    loading.storeRationale(rationale);
    expect(store.size).toBe(0);
  });

  test("storage the browser refuses is not an error", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    const s = surveyAt("s1", 120);
    expect(() => s.stash.set(FORM, form)).not.toThrow();
    expect(() => s.stash.delete(FORM)).not.toThrow();
    expect(() => s.storeRationale(rationale)).not.toThrow();
    expect(s.stash.get(FORM, questions)).toBeUndefined();
    expect(s.loadRationale()).toBeUndefined();
  });

  test("each network keeps its own answers", () => {
    vi.stubGlobal("__DEPLOYMENT__", {
      network: "preprod",
      appUrls: {},
      commit: "test",
    });
    surveyAt("s1", 120).stash.set(FORM, form);
    expect([...store.keys()]).toEqual(["tessera.responseDrafts.preprod"]);
  });
});
