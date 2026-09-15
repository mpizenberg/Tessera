import { describe, expect, it } from "vitest";

import { lovelace, parseKoiosJson, stringifyKoiosJson } from "./json";

describe("parseKoiosJson", () => {
  const text =
    '{"big":18446744073709551615,"neg":-21391325252789667,"safe":42,' +
    '"float":1.5,"digits":"21391325252789667","list":[9007199254740993]}';

  it("keeps every integer exact, and leaves the rest as JSON.parse does", () => {
    expect(parseKoiosJson(text)).toEqual({
      big: 18446744073709551615n,
      neg: -21391325252789667n,
      safe: 42,
      float: 1.5,
      digits: "21391325252789667",
      list: [9007199254740993n],
    });
  });

  it("refuses a number above 2^53 it cannot read digit for digit", () => {
    expect(() => parseKoiosJson('{"a":1e20}')).toThrow("1e20");
    expect(() => parseKoiosJson('{"a":12345678901234567.5}')).toThrow();
  });

  it("is inverted by stringifyKoiosJson", () => {
    expect(stringifyKoiosJson(parseKoiosJson(text))).toBe(text);
  });
});

describe("lovelace", () => {
  it("reads a decimal string, a safe number or a bigint", () => {
    expect(lovelace("21391325252789667", "f")).toBe(21391325252789667n);
    expect(lovelace(157298068, "f")).toBe(157298068n);
    expect(lovelace(0, "f")).toBe(0n);
    expect(lovelace(21391325252789667n, "f")).toBe(21391325252789667n);
  });

  it("refuses anything else, naming the field", () => {
    for (const bad of [1.5, -1, 2 ** 60, "1.5", "-1", "", null, -1n]) {
      expect(() => lovelace(bad, "epoch_info.active_stake")).toThrow(
        "epoch_info.active_stake",
      );
    }
  });
});
