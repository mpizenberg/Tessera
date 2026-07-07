import { describe, expect, it } from "vitest";

import { blake2b256Hex, canonicalJson } from "./canonical.js";

describe("canonicalJson", () => {
  it("sorts object keys and emits no whitespace", () => {
    expect(canonicalJson({ b: 1, a: 2, c: { z: 0, y: [1, "x"] } })).toBe(
      '{"a":2,"b":1,"c":{"y":[1,"x"],"z":0}}',
    );
  });

  it("sorts keys by UTF-16 code units (uppercase before lowercase)", () => {
    expect(canonicalJson({ a: 1, B: 2 })).toBe('{"B":2,"a":1}');
  });

  it("is insensitive to property insertion order (idempotent form)", () => {
    const one = canonicalJson({ x: 1, y: { b: 2, a: 3 } });
    const two = canonicalJson({ y: { a: 3, b: 2 }, x: 1 });
    expect(one).toBe(two);
  });

  it("renders primitives and escapes strings like JSON", () => {
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(true)).toBe("true");
    expect(canonicalJson(-0)).toBe("0");
    expect(canonicalJson('he said "hi"\n')).toBe('"he said \\"hi\\"\\n"');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
  });

  it("omits undefined object properties (like JSON.stringify)", () => {
    expect(canonicalJson({ a: 1, gone: undefined })).toBe('{"a":1}');
  });

  it("throws on floats, unsafe integers, NaN and infinities", () => {
    expect(() => canonicalJson(0.5)).toThrow(/non-integer/);
    expect(() => canonicalJson(Number.MAX_SAFE_INTEGER + 1)).toThrow(
      /non-integer|unsafe/,
    );
    expect(() => canonicalJson(NaN)).toThrow();
    expect(() => canonicalJson(Infinity)).toThrow();
  });

  it("throws on bigints, pointing at the offending path", () => {
    expect(() => canonicalJson({ w: { weight: 5n } })).toThrow(/\$\.w\.weight/);
  });

  it("throws on non-plain objects and undefined array elements", () => {
    expect(() => canonicalJson(new Map())).toThrow(/non-plain/);
    expect(() => canonicalJson(new Uint8Array([1]))).toThrow(/non-plain/);
    expect(() => canonicalJson([undefined])).toThrow(/unsupported undefined/);
  });
});

describe("blake2b256Hex", () => {
  // Standard blake2b-256 vectors (independently reproducible with b2sum -l 256).
  it("matches known blake2b-256 test vectors", () => {
    expect(blake2b256Hex("")).toBe(
      "0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8",
    );
    expect(blake2b256Hex("abc")).toBe(
      "bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319",
    );
  });

  it("hashes the UTF-8 encoding (multi-byte chars are stable)", () => {
    expect(blake2b256Hex("é")).toBe(blake2b256Hex("é"));
    expect(blake2b256Hex("é")).not.toBe(blake2b256Hex("e"));
  });
});
