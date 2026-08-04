import { describe, expect, test } from "vitest";

import { explorerTxUrl, networkMismatch } from "./format";

const TX = "ab".repeat(32);

describe("network presentation", () => {
  test.each([
    ["mainnet", `https://explorer.cardano.org/tx/${TX}`],
    ["preprod", `https://explorer.cardano.org/preprod/tx/${TX}`],
    ["preview", `https://explorer.cardano.org/preview/tx/${TX}`],
  ] as const)("builds the %s explorer URL", (network, expected) => {
    expect(explorerTxUrl(network, TX)).toBe(expected);
  });

  test("CIP-30 can reject mainnet but cannot distinguish the testnets", () => {
    expect(networkMismatch(1, "mainnet")).toBe(false);
    expect(networkMismatch(0, "mainnet")).toBe(true);
    expect(networkMismatch(0, "preprod")).toBe(false);
    expect(networkMismatch(0, "preview")).toBe(false);
  });
});
