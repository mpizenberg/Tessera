import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  DIRECT_MODE_TTL_MS,
  activateDirectMode,
  deactivateDirectMode,
  directModeUntil,
  resolveIndexerUrl,
  storeKoiosToken,
  storedKoiosToken,
} from "./config";

// Tests run in plain Node (vitest environment "node"): no DOM, so localStorage
// is stubbed with a Map-backed shim, and the wall clock with fake timers.
const store = new Map<string, string>();

const NOW = 1_800_000_000_000;
const URL_KEY = "tessera.indexerUrl.preview";
const BACKEND = "https://backend.example";

beforeEach(() => {
  store.clear();
  store.set(URL_KEY, BACKEND);
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("emergency direct mode", () => {
  test("no stamp: reads resolve to the configured backend", () => {
    expect(directModeUntil()).toBeUndefined();
    expect(resolveIndexerUrl()).toBe(BACKEND);
  });

  test("a fresh stamp overrides the backend URL until its TTL", () => {
    activateDirectMode();
    expect(directModeUntil()).toBe(NOW + DIRECT_MODE_TTL_MS);
    expect(resolveIndexerUrl()).toBeUndefined();
  });

  test("an expired stamp is inert: the serving tier resumes", () => {
    activateDirectMode();
    vi.setSystemTime(NOW + DIRECT_MODE_TTL_MS);
    expect(directModeUntil()).toBeUndefined();
    expect(resolveIndexerUrl()).toBe(BACKEND);
  });

  test("an unreadable stamp is inert", () => {
    store.set("tessera.directSince.preview", "not-a-number");
    expect(directModeUntil()).toBeUndefined();
    expect(resolveIndexerUrl()).toBe(BACKEND);
  });

  test("deactivation removes the stamp but never the stored token", () => {
    storeKoiosToken("my-koios-token");
    activateDirectMode();
    deactivateDirectMode();
    expect(directModeUntil()).toBeUndefined();
    expect(resolveIndexerUrl()).toBe(BACKEND);
    expect(storedKoiosToken()).toBe("my-koios-token");
  });

  test("expiry leaves the stored token untouched too", () => {
    storeKoiosToken("my-koios-token");
    activateDirectMode();
    vi.setSystemTime(NOW + DIRECT_MODE_TTL_MS + 1);
    expect(directModeUntil()).toBeUndefined();
    expect(storedKoiosToken()).toBe("my-koios-token");
  });
});
