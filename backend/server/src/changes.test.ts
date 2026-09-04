import { describe, expect, it } from "vitest";

import {
  advanceAxis,
  changesCursorAt,
  encodeChangesCursor,
  parseChangesCursor,
} from "./changes";

const KEY = `${"ab".repeat(32)}:0`;

describe("changes cursor", () => {
  it("round-trips both axes in either form", () => {
    for (const cursor of [
      changesCursorAt(1_750_000_000),
      { rows: { stamp: 5, key: KEY }, removed: { stamp: 7, key: null } },
      { rows: { stamp: 5, key: null }, removed: { stamp: 7, key: KEY } },
    ])
      expect(parseChangesCursor(encodeChangesCursor(cursor))).toEqual(cursor);
  });

  it("refuses anything it did not mint", () => {
    for (const s of [
      "",
      "5",
      "5.-",
      `5.${KEY}`,
      `5.${KEY}.7`,
      `5.${KEY}:1.7.-`,
      `5.${"AB".repeat(32)}:0.7.-`,
      `5.${"ab".repeat(32)}:01.7.-`,
      `-5.-.7.-`,
      `5.-.7.-.`,
    ])
      expect(parseChangesCursor(s), s).toBeNull();
  });
});

describe("advanceAxis", () => {
  const at = (stamp: number, key: string) => ({ stamp, key });

  it("continues from the page's last item when more followed", () => {
    expect(advanceAxis([at(1, "a"), at(2, "b"), at(2, "c")], 2, 9)).toEqual({
      stamp: 2,
      key: "b",
    });
  });

  it("advances to the published generation when the axis is exhausted", () => {
    expect(advanceAxis([at(1, "a"), at(2, "b")], 2, 9)).toEqual({
      stamp: 9,
      key: null,
    });
    expect(advanceAxis([], 2, 9)).toEqual({ stamp: 9, key: null });
  });
});
