import { beforeEach, describe, expect, test } from "vitest";

import { setLocale } from "~/i18n";
import { explorerTxUrl, formatAda, networkMismatch } from "./format";

const TX = "ab".repeat(32);

// Force a deterministic locale — the i18n module otherwise sniffs
// navigator/storage, which vary by machine. Also restores `en` after the case
// that switches away from it.
beforeEach(async () => {
  await setLocale("en");
});

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

describe("formatAda", () => {
  test("renders whole ada, dropping the lovelace remainder", () => {
    expect(formatAda(512_793_397_078n)).toBe("512,793");
    expect(formatAda(0n)).toBe("0");
    expect(formatAda(999_999n)).toBe("<1");
  });

  test("groups for the active locale", async () => {
    await setLocale("fr");
    // Which space ICU picks (narrow no-break, no-break) varies by version; that
    // it is not the English comma is the point.
    expect(formatAda(512_793_397_078n)).toMatch(/^512\s793$/);
  });
});
