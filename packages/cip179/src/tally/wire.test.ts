import { describe, expect, it } from "vitest";

import { fromJsonSafe, toJsonSafe } from "./wire.js";

/** Round-trip through JSON.stringify/parse, the way the wire path actually uses it. */
function roundTrip(value: unknown): unknown {
  return fromJsonSafe(JSON.parse(JSON.stringify(toJsonSafe(value))));
}

describe("wire codec", () => {
  it("preserves bytes, bigints, nested maps, and arrays across JSON", () => {
    const value = {
      txId: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
      big: 18446744073709551617n, // > 2^64, well past lossy-double range
      role: 1,
      title: "hello",
      flag: true,
      nil: null,
      answers: [
        { optionIndex: 0, rating: 5n },
        { optionIndex: 2, rating: -3n },
      ],
      custom: new Map<unknown, unknown>([
        [0n, new Uint8Array([1, 2, 3])],
        ["k", [1n, 2n]],
      ]),
    };
    const back = roundTrip(value) as typeof value;

    expect(back.txId).toBeInstanceOf(Uint8Array);
    expect([...back.txId]).toEqual([0xde, 0xad, 0xbe, 0xef]);
    expect(back.big).toBe(18446744073709551617n);
    expect(back.answers[1]).toEqual({ optionIndex: 2, rating: -3n });
    expect(back.custom).toBeInstanceOf(Map);
    expect(back.custom.get(0n)).toEqual(new Uint8Array([1, 2, 3]));
    expect(back.custom.get("k")).toEqual([1n, 2n]);
    expect(back.nil).toBeNull();
  });

  it("drops undefined optional fields (absent stays absent)", () => {
    const back = roundTrip({ a: 1, b: undefined }) as Record<string, unknown>;
    expect("b" in back).toBe(false);
    expect(back["a"]).toBe(1);
  });

  it("leaves an empty byte array recoverable", () => {
    const back = roundTrip({ e: new Uint8Array([]) }) as { e: Uint8Array };
    expect(back.e).toBeInstanceOf(Uint8Array);
    expect(back.e.length).toBe(0);
  });

  // Finding 32 — a sealed artifact hashes a custom answer's map, so the wire
  // form must not inherit whichever entry order the injected CBOR decoder
  // reported. Ruleset v9 sorts by the canonical JSON of the tagged key.
  describe("$map entry order is canonical, not the decoder's", () => {
    const entries: [unknown, unknown][] = [
      [2n, "two"],
      ["k", 1n],
      [new Uint8Array([0xff]), "bytes"],
      [0n, "zero"],
    ];

    it("serializes the same bytes whatever order a decoder produced", () => {
      const forward = JSON.stringify(toJsonSafe(new Map(entries)));
      const reversed = JSON.stringify(
        toJsonSafe(new Map([...entries].reverse())),
      );
      expect(forward).toBe(reversed);
    });

    it("sorts nested maps too", () => {
      const nest = (es: [unknown, unknown][]): unknown =>
        new Map<unknown, unknown>([["outer", new Map(es)]]);
      expect(JSON.stringify(toJsonSafe(nest(entries)))).toBe(
        JSON.stringify(toJsonSafe(nest([...entries].reverse()))),
      );
    });

    it("still round-trips every key to its own value", () => {
      const back = roundTrip(new Map(entries)) as Map<unknown, unknown>;
      expect(back.get(2n)).toBe("two");
      expect(back.get("k")).toBe(1n);
      expect(back.get(0n)).toBe("zero");
      expect([...back.keys()].length).toBe(4);
    });
  });
});
