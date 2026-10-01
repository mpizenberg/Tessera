import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

/** A kept form as the answering spine hands it over: plain JSON. */
const form = [{ skipped: false, value: { type: "custom", text: "why not" } }];

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

describe("unsent answers survive a reload", () => {
  test("an ended survey's entry goes on the next write, but not while the tip is unknown", () => {
    const ended = surveyAt("old", 99);
    ended.setTip(undefined);
    ended.stash.set("old", form);
    const open = surveyAt("new", 120);
    open.setTip(undefined);
    open.stash.set("new", form);
    expect(ended.stash.get("old")).toEqual(form);

    open.setTip(100);
    open.stash.set("new", form);
    expect(ended.stash.get("old")).toBeUndefined();
    expect(open.stash.get("new")).toEqual(form);
  });

  test("the rationale is kept per survey until it is emptied", () => {
    const s = surveyAt("s1", 120);
    s.storeRationale(rationale);
    expect(surveyAt("s1", 120).loadRationale()).toEqual(rationale);
    expect(surveyAt("s2", 120).loadRationale()).toBeUndefined();

    s.storeRationale({ ...rationale, text: "  " });
    expect(s.loadRationale()).toBeUndefined();
  });

  test("the key goes once the survey's form and rationale do", () => {
    const s = surveyAt("s1", 120);
    s.stash.set("s1", form);
    s.storeRationale(rationale);
    s.stash.delete("s1");
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
    loading.stash.set("s1", form);
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
    expect(() => s.stash.set("s1", form)).not.toThrow();
    expect(() => s.stash.delete("s1")).not.toThrow();
    expect(() => s.storeRationale(rationale)).not.toThrow();
    expect(s.stash.get("s1")).toBeUndefined();
    expect(s.loadRationale()).toBeUndefined();
  });

  test("each network keeps its own answers", () => {
    vi.stubGlobal("__DEPLOYMENT__", {
      network: "preprod",
      appUrls: {},
      commit: "test",
    });
    surveyAt("s1", 120).stash.set("s1", form);
    expect([...store.keys()]).toEqual(["tessera.responseDrafts.preprod"]);
  });
});
