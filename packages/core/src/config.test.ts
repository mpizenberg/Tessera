import { describe, expect, test } from "vitest";

import { KOIOS_URL, NETWORKS, SECONDS_PER_EPOCH, parseNetwork } from "./config";

describe("network configuration", () => {
  test.each(NETWORKS)("accepts %s", (network) => {
    expect(parseNetwork(network)).toBe(network);
  });

  test.each([undefined, null, "", "testnet", "PREPROD"])(
    "rejects unsupported value %s",
    (value) => {
      expect(() => parseNetwork(value)).toThrow(/Unsupported Cardano network/);
    },
  );

  test("pins each Koios endpoint and epoch duration", () => {
    expect(KOIOS_URL).toEqual({
      mainnet: "https://api.koios.rest/api/v1",
      preprod: "https://preprod.koios.rest/api/v1",
      preview: "https://preview.koios.rest/api/v1",
    });
    expect(SECONDS_PER_EPOCH).toEqual({
      mainnet: 432_000,
      preprod: 432_000,
      preview: 86_400,
    });
  });
});
