import { describe, expect, it, test } from "vitest";

import {
  EPOCH_ZERO_UNIX,
  NETWORKS,
  SECONDS_PER_EPOCH,
  currentEpoch,
  epochOfShelleySlot,
  firstSlot,
  parseNetwork,
} from "./network.js";

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

  it("pins each epoch duration", () => {
    expect(SECONDS_PER_EPOCH).toEqual({
      mainnet: 432_000,
      preprod: 432_000,
      preview: 86_400,
    });
  });
});

describe("currentEpoch", () => {
  // Tips read from Koios on 2026-09-03: block time, the epoch the ledger
  // reported for it, and the slot within that epoch.
  const tips = [
    { network: "mainnet", time: 1788478223, epoch: 653, epochSlot: 179132 },
    { network: "preprod", time: 1788478198, epoch: 311, epochSlot: 84598 },
    { network: "preview", time: 1788478215, epoch: 1409, epochSlot: 84615 },
  ] as const;

  test.each(tips)(
    "$network: the calendar agrees with the ledger's tip",
    ({ network, time, epoch, epochSlot }) => {
      expect(currentEpoch(network, time)).toBe(epoch);
      // The anchor is exact, not merely within the epoch: the epoch began
      // `epochSlot` seconds before the tip.
      expect(
        EPOCH_ZERO_UNIX[network] + epoch * SECONDS_PER_EPOCH[network],
      ).toBe(time - epochSlot);
    },
  );

  it("rolls over exactly at the epoch boundary", () => {
    const start = EPOCH_ZERO_UNIX.preview + 1409 * SECONDS_PER_EPOCH.preview;
    expect(currentEpoch("preview", start - 1)).toBe(1408);
    expect(currentEpoch("preview", start)).toBe(1409);
  });
});

describe("Shelley slots", () => {
  it.each(NETWORKS)("maps an epoch's first and last slot back on %s", (n) => {
    const epoch = 420;
    expect(epochOfShelleySlot(n, firstSlot(n, epoch))).toBe(epoch);
    expect(epochOfShelleySlot(n, firstSlot(n, epoch + 1) - 1)).toBe(epoch);
  });

  // The last block of an epoch, as PRAGMA's bootstrap index names it.
  it.each([
    { network: "preview", slot: 86399953, epoch: 999 },
    { network: "preprod", slot: 114134379, epoch: 267 },
    { network: "mainnet", slot: 172972789, epoch: 597 },
  ] as const)("puts slot $slot in $network epoch $epoch", (c) => {
    expect(epochOfShelleySlot(c.network, c.slot)).toBe(c.epoch);
  });

  it("refuses an epoch or a slot before Shelley", () => {
    expect(() => firstSlot("mainnet", 100)).toThrow(/before Shelley/);
    expect(() => epochOfShelleySlot("mainnet", 4_000_000)).toThrow(
      /before Shelley/,
    );
  });
});
