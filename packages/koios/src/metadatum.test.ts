import { describe, expect, it } from "vitest";

import { parseKoiosJson } from "./json";
import { koiosJsonToMetadatum, type KoiosJson } from "./metadatum";

describe("koiosJsonToMetadatum", () => {
  it("converts safe integers to exact bigints", () => {
    expect(koiosJsonToMetadatum(0)).toBe(0n);
    expect(koiosJsonToMetadatum(42)).toBe(42n);
    expect(koiosJsonToMetadatum(-7)).toBe(-7n);
    expect(koiosJsonToMetadatum(Number.MAX_SAFE_INTEGER)).toBe(
      BigInt(Number.MAX_SAFE_INTEGER),
    );
  });

  it("keeps integers beyond 2^53 exact, at top level and inside a map", () => {
    const json = parseKoiosJson(
      '{"0":18446744073709551615,"1":[-21391325252789667]}',
    ) as KoiosJson;
    expect(koiosJsonToMetadatum(json)).toEqual(
      new Map<bigint, unknown>([
        [0n, 18_446_744_073_709_551_615n],
        [1n, [-21_391_325_252_789_667n]],
      ]),
    );
    expect(koiosJsonToMetadatum(18_446_744_073_709_551_615n)).toBe(
      18_446_744_073_709_551_615n,
    );
  });

  it("rejects a number beyond 2^53, which a lossy parse already rounded", () => {
    // The only honest thing to do is refuse, so the caller skips the tx as
    // malformed (finding 9).
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
