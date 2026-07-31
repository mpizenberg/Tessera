import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { SPEC_VERSION, type SurveyDefinition } from "cip-179";

import type { Action } from "./action";
import { loadCart, storeCart } from "./cart";

// Same shim as pending.test.ts: these tests run in plain Node, no DOM.
const store = new Map<string, string>();
const KEY = "tessera.cart.preview";

beforeEach(() => {
  store.clear();
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
});

afterEach(() => vi.unstubAllGlobals());

const definition: SurveyDefinition = {
  specVersion: SPEC_VERSION,
  owner: { type: "key", keyHash: new Uint8Array(28).fill(1) },
  title: "Which way?",
  description: "",
  eligibleRoles: [],
  endEpoch: 42,
  submissionMode: { type: "public" },
  questions: [],
};
const publish: Action = {
  kind: "survey",
  definition,
  proveCredentials: [],
  title: "Which way?",
};
const propose: Action = {
  kind: "govAction",
  anchorUrl: "ipfs://doc",
  anchorDataHash: new Uint8Array(32),
  surveyKey: undefined,
  proveCredentials: [],
};

describe("the queue survives a reload", () => {
  test("actions come back in the order they were queued", () => {
    storeCart([publish, propose]);
    expect(loadCart()).toEqual([publish, propose]);
  });

  test("an entry that no longer decodes goes without taking the rest", () => {
    store.set(KEY, JSON.stringify([{ kind: "survey" }, { no: 1 }]));
    expect(loadCart()).toEqual([]);
    storeCart([publish]);
    const stored = JSON.parse(store.get(KEY)!) as unknown[];
    store.set(KEY, JSON.stringify([{ no: 1 }, ...stored]));
    expect(loadCart()).toEqual([publish]);
  });

  test("an emptied cart clears the key rather than storing []", () => {
    storeCart([publish]);
    storeCart([]);
    expect(store.has(KEY)).toBe(false);
  });

  test("storage the browser refuses is not an error", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {},
    });
    expect(() => storeCart([publish])).not.toThrow();
    expect(loadCart()).toEqual([]);
  });
});
