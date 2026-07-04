import { describe, expect, it } from "vitest";

import { koiosJsonToMetadatum } from "./metadatum";

describe("koiosJsonToMetadatum", () => {
  it("converts safe integers to exact bigints", () => {
    expect(koiosJsonToMetadatum(0)).toBe(0n);
    expect(koiosJsonToMetadatum(42)).toBe(42n);
    expect(koiosJsonToMetadatum(-7)).toBe(-7n);
    expect(koiosJsonToMetadatum(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("rejects numbers beyond 2^53 rather than truncating to a wrong bigint", () => {
    // Koios has already lost precision at this point; the only honest thing to
    // do is refuse, so the caller skips the tx as malformed (finding 9).
    expect(() => koiosJsonToMetadatum(2 ** 53)).toThrow(/safe integer/);
    expect(() => koiosJsonToMetadatum(1e21)).toThrow(/safe integer/);
  });

  it("rejects non-integer numbers", () => {
    expect(() => koiosJsonToMetadatum(1.5)).toThrow(/safe integer/);
  });

  it("parses large integer object keys exactly from their string form", () => {
    const big = "9007199254740993"; // 2^53 + 1, unrepresentable as a JS number
    const map = koiosJsonToMetadatum({ [big]: 1 }) as Map<unknown, unknown>;
    expect(map.has(BigInt(big))).toBe(true);
  });

  it("decodes 0x-prefixed strings to bytes and plain strings to text", () => {
    expect(koiosJsonToMetadatum("0x00ff")).toEqual(new Uint8Array([0, 255]));
    expect(koiosJsonToMetadatum("hello")).toBe("hello");
  });
});
