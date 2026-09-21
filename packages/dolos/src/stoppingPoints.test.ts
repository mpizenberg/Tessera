import { describe, expect, it } from "vitest";

import { stoppingPoints } from "./stoppingPoints";

describe("stoppingPoints", () => {
  it("gives the files of the preview audit measured for end_epoch 1395", () => {
    expect(stoppingPoints("preview", 1395)).toEqual({
      endDownloadEnd: 27920,
      afterDownloadStart: 27919,
      afterDownloadEnd: 27941,
      stopEpoch: 1397,
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
      const first = stoppingPoints(network, epoch - 1).endDownloadEnd;
      const last = stoppingPoints(network, epoch).afterDownloadStart;
      expect(latest).toBeLessThanOrEqual(last);
      expect(first - earliest).toBeLessThanOrEqual(4);
    },
  );

  it("refuses an epoch before Shelley", () => {
    expect(() => stoppingPoints("mainnet", 100)).toThrow(/before Shelley/);
  });
});
