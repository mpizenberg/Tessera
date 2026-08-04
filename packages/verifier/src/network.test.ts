import { describe, expect, test } from "vitest";

import { networkFromHealth } from "./network";

describe("backend network identity", () => {
  test.each(["mainnet", "preprod", "preview"])("accepts %s", (network) => {
    expect(networkFromHealth({ network })).toBe(network);
  });

  test.each([
    undefined,
    null,
    {},
    { network: undefined },
    { network: "testnet" },
    { network: 0 },
  ])("rejects malformed health payload %#", (health) => {
    expect(() => networkFromHealth(health)).toThrow();
  });
});
