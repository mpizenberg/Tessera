import { describe, expect, it } from "vitest";

import { fileOf, firstSlot, stoppingPoint } from "./stoppingPoints";

describe("stoppingPoint", () => {
  it("gives the file and epoch of the preview audit measured for end_epoch 1428", () => {
    expect(stoppingPoint("preview", 1428)).toEqual({
      downloadEnd: 28581,
      stopEpoch: 1429,
    });
  });

  // The last immutable file of each Mithril Cardano database snapshot signed
  // in an epoch, on 2026-09-21. The immutable DB trails the tip, so the files
  // of a snapshot signed early in an epoch still belong to the one before.
  const SIGNED = [
    { network: "preview", epoch: 1426, files: [28530, 28536] },
    { network: "preview", epoch: 1427, files: [28536, 28548] },
    { network: "preprod", epoch: 313, files: [6195, 6200] },
    { network: "preprod", epoch: 314, files: [6200, 6215] },
    { network: "mainnet", epoch: 656, files: [9164, 9183] },
  ] as const;

  it.each(SIGNED)(
    "places the files Mithril signed in $network epoch $epoch",
    ({ network, epoch, files: [earliest, latest] }) => {
      const first = fileOf(network, firstSlot(network, epoch));
      const last = fileOf(network, firstSlot(network, epoch + 1) - 1);
      expect(latest).toBeLessThanOrEqual(last);
      expect(first - earliest).toBeLessThanOrEqual(4);
    },
  );

  it("refuses an epoch before Shelley", () => {
    expect(() => stoppingPoint("mainnet", 100)).toThrow(/before Shelley/);
  });
});
