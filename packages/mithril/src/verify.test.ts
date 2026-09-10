import { describe, expect, it } from "vitest";

import { VERIFICATION_KEY, verifyManifest, type Manifest } from "./verify";

/** The manifest of preview's epoch-1414 ancillary (immutable 28290), as shipped. */
const shipped: Manifest = JSON.parse(
  '{"data":{"immutable/28291.chunk":"42000526fb7e39bedfc2f970a2748964df2f86e09c631aeba610ed0571b780ba","immutable/28291.primary":"9c6ab5466d647cdafe26053e1ae06c65ce1a9aab0392385b10ddbc598335daa5","immutable/28291.secondary":"fd05967683aa82a688690131a72d0ed7fd04c5d0cd6e2e01a4b66aaa17a28d22","ledger/122216523/meta":"606b1c61abe55c8563531133a55d94a7d61660c25c6a094ad4ac27ce2fd06d57","ledger/122216523/state":"cfa8b57fad8751afce554d1e615c4aa792a88acef63b61838fa7eb00defba5f0","ledger/122216523/tables":"3bee28629809fa00a8b857e3c927c34554c11d4c1278e4ac1a048082f0b4097c"},"signature":"d156c8cbdf2d1a29652e095914932c51abb010bbb7ea28f91ff369bc07edddb378e7d6af63ebfc33b4f1d790635e4985748a77d29cf65bb01f9e825203b74309"}',
);

describe("the shipped preview manifest", () => {
  it("verifies against the pinned preview key", () => {
    expect(verifyManifest(shipped, VERIFICATION_KEY.preview!)).toBe(true);
  });

  it("does not verify once one hash changes", () => {
    const state = "ledger/122216523/state";
    const data = {
      ...shipped.data,
      [state]: shipped.data[state]!.replace("cfa8", "cfa9"),
    };
    expect(
      verifyManifest({ ...shipped, data }, VERIFICATION_KEY.preview!),
    ).toBe(false);
  });

  it("does not verify against the mainnet key", () => {
    expect(verifyManifest(shipped, VERIFICATION_KEY.mainnet!)).toBe(false);
  });
});
