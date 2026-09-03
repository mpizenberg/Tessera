import { NETWORKS } from "cardano-tessera-client";
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

  test("gives each network its own default cache file", () => {
    const paths = NETWORKS.map(
      (network) => loadConfig({ NETWORK: network }).dbPath,
    );
    expect(paths).toEqual([
      "./tessera-cache-mainnet.sqlite",
      "./tessera-cache-preprod.sqlite",
      "./tessera-cache-preview.sqlite",
    ]);
    expect(new Set(paths).size).toBe(NETWORKS.length);
  });

  test("preserves an explicit cache path override", () => {
    expect(loadConfig({ NETWORK: "preprod", DB_PATH: ":memory:" }).dbPath).toBe(
      ":memory:",
    );
  });
});
