import { describe, expect, test } from "vitest";

import { loadConfig } from "./config";

describe("server network configuration", () => {
  test.each([{}, { NETWORK: "" }])(
    "defaults an absent network to Preview for local development",
    (env) => {
      expect(loadConfig(env).app).toMatchObject({
        network: "preview",
        koiosUrl: "https://preview.koios.rest/api/v1",
        secondsPerEpoch: 86_400,
      });
    },
  );

  test.each([
    ["mainnet", "https://api.koios.rest/api/v1", 432_000],
    ["preprod", "https://preprod.koios.rest/api/v1", 432_000],
    ["preview", "https://preview.koios.rest/api/v1", 86_400],
  ] as const)("loads %s defaults", (network, koiosUrl, secondsPerEpoch) => {
    expect(loadConfig({ NETWORK: network }).app).toMatchObject({
      network,
      koiosUrl,
      secondsPerEpoch,
    });
  });

  test("preserves an explicit Koios override", () => {
    expect(
      loadConfig({ NETWORK: "preprod", KOIOS_URL: "https://koios.example" }).app
        .koiosUrl,
    ).toBe("https://koios.example");
  });

  test.each(["testnet", "Preprod", " "])(
    "rejects unknown network %j instead of falling back to Preview",
    (network) => {
      expect(() => loadConfig({ NETWORK: network })).toThrow(
        /Unsupported Cardano network/,
      );
    },
  );
});
