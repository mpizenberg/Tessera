import { readFileSync } from "node:fs";

import type { Credential } from "cip-179";
import { hexToBytes } from "cip-179/domain";
import { describe, expect, it } from "vitest";

import type { DolosNode } from "./node";
import { DolosTallyInputs } from "./tallyInputs";

const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}.txt`, import.meta.url), "utf8");

// The fixtures' store: preview, at the first block of 1429.
const TIP = 123465614;
const DELEGATED = "cbf787411c70bb4bb974ddd7709676fa5858d2b98b31b7a99b6f0f4a";
const DREP = "07619b09629511c3949ddcfa0decc5d6cc75dd27437a29775e7c36d9";
const POOL = "2afbef2f8a3a624f6f4492260fe2053f6daebd8c5ff13f6f14574417";
const ABSENT = "ab".repeat(28);

const key = (hash: string): Credential => ({
  type: "key",
  keyHash: hexToBytes(hash),
});

function node(
  entities: Record<string, string>,
  tip: number | null = TIP,
): Pick<DolosNode, "dir" | "tipSlot" | "dump"> & { asked: string[] } {
  const asked: string[] = [];
  return {
    dir: "/store",
    asked,
    tipSlot: async () => tip,
    dump: async (namespace, k) => {
      asked.push(`${namespace}/${k}`);
      return entities[`${namespace}/${k}`] ?? null;
    },
  };
}

describe("DolosTallyInputs", () => {
  const entities = {
    [`accounts/8200581c${DELEGATED}`]: fixture("account-delegated"),
    [`dreps/22${DREP}`]: fixture("drep-reregistered"),
    [`pools/${POOL}`]: fixture("pool"),
  };

  it("weighs a stakeholder by its mark behind a pool standing then", async () => {
    const store = node(entities);
    const got = await new DolosTallyInputs(store, "preview").stakeholderWeights(
      1428,
      [key(DELEGATED), key(ABSENT)],
    );
    expect(got.get(`key:${DELEGATED}`)).toEqual({
      registered: true,
      weight: 8_073_247_350_332n,
    });
    expect(got.get(`key:${ABSENT}`)).toEqual({
      registered: false,
      weight: 0n,
    });
    expect(store.asked).toContain(`pools/${POOL}`);
  });

  it("weighs 0 behind a pool retired at the end", async () => {
    let n = 0;
    const retired = fixture("pool").replace(/is_retired: false/g, (m) =>
      ++n === 2 ? "is_retired: true" : m,
    );
    const got = await new DolosTallyInputs(
      node({ ...entities, [`pools/${POOL}`]: retired }),
      "preview",
    ).stakeholderWeights(1428, [key(DELEGATED)]);
    expect(got.get(`key:${DELEGATED}`)).toEqual({
      registered: true,
      weight: 0n,
    });
  });

  it("weighs a DRep by the distribution taken at the end", async () => {
    const got = await new DolosTallyInputs(
      node(entities),
      "preview",
    ).drepWeights(1428, [key(DREP), key(ABSENT)]);
    expect(got.get(`key:${DREP}`)).toEqual({
      registered: true,
      weight: 75_086_827n,
    });
    expect(got.get(`key:${ABSENT}`)).toEqual({
      registered: false,
      weight: 0n,
    });
  });

  it("refuses a store not standing in the next epoch", async () => {
    for (const tip of [TIP - 86_400, TIP + 86_400, null])
      await expect(
        new DolosTallyInputs(node(entities, tip), "preview").drepWeights(1428, [
          key(DREP),
        ]),
      ).rejects.toThrow(/not in epoch 1429/);
  });

  it("names the credential a refusal is about", async () => {
    const text = fixture("drep-reregistered").replace("78218899", String(TIP));
    await expect(
      new DolosTallyInputs(
        node({ [`dreps/22${DREP}`]: text }),
        "preview",
      ).drepWeights(1428, [key(DREP)]),
    ).rejects.toThrow(`key:${DREP}: unregistered at slot ${TIP}`);
  });
});
