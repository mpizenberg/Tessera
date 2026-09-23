import { describe, expect, it } from "vitest";

import { MAX_MISSES } from "./backoff";
import { reusableScripts } from "./scriptLookups";
import { testStore } from "./testing/store";

const HASH = "5c".repeat(28);
const FOUND = {
  script: { kind: "sig", keyHash: "b2".repeat(28) },
  epoch: 7,
} as const;

/** A bank holding `misses` lookups of HASH that found none, the last at 0. */
async function bankedMisses(misses: number) {
  const store = testStore();
  for (let i = 0; i < misses; i++)
    await store.putScriptLookups(new Map(), [HASH], 0);
  return store;
}

const reused = async (
  store: ReturnType<typeof testStore>,
  now: number,
  fresh: readonly string[] = [],
) => (await reusableScripts(store, [HASH], new Set(fresh), now)).get(HASH);

describe("reusableScripts — the backoff", () => {
  it("asks again after a delay that doubles with each miss", async () => {
    const once = await bankedMisses(1);
    expect(await reused(once, 179)).toBe("none");
    expect(await reused(once, 180)).toBeUndefined();
    const twice = await bankedMisses(2);
    expect(await reused(twice, 359)).toBe("none");
    expect(await reused(twice, 360)).toBeUndefined();
  });

  it("stops asking once the lookups are used up, unless fresh", async () => {
    const spent = await bankedMisses(MAX_MISSES);
    expect(await reused(spent, 10 ** 9)).toBe("none");
    expect(await reused(spent, 0, [HASH])).toBeUndefined();
  });

  it("serves a script found for good, and a miss never rewrites it", async () => {
    const store = testStore();
    await store.putScriptLookups(new Map([[HASH, FOUND]]), [], 0);
    await store.putScriptLookups(new Map(), [HASH], 5);
    expect(await reused(store, 0, [HASH])).toEqual(FOUND);
  });
});
