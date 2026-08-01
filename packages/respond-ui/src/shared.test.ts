import { describe, expect, it } from "vitest";

import type { I18n } from "cardano-tessera-respond-core";

import { clampStep, labelFor, ratingLevels } from "./shared";

/** Key-echoing i18n stub: `t` renders "key{params}" so assertions stay exact. */
const stub: I18n = {
  t: (key, params) => (params ? `${key}${JSON.stringify(params)}` : key),
  n: (value) => String(value),
  d: (unixSeconds) => String(unixSeconds),
};

describe("clampStep", () => {
  it("clamps into [min, max] then snaps down onto the step grid", () => {
    expect(clampStep(7n, 0n, 10n, 3n)).toBe(6n);
    expect(clampStep(-5n, 0n, 10n, 3n)).toBe(0n);
    expect(clampStep(99n, 0n, 10n, 3n)).toBe(9n);
  });

  it("passes values through when step is 1", () => {
    expect(clampStep(4n, 0n, 10n, 1n)).toBe(4n);
  });
});

describe("labelFor", () => {
  it("returns the option label when present", () => {
    const opts = { type: "options", labels: ["Yes", "No"] } as const;
    expect(labelFor(stub, opts, 1)).toBe("No");
  });

  it("falls back to the locale-formatted 'Option N' for count options", () => {
    const opts = { type: "count", count: 3 } as const;
    expect(labelFor(stub, opts, 2)).toBe('respond.optionFallback{"n":"3"}');
  });
});

describe("ratingLevels", () => {
  it("maps label scales to 0-based values with the given labels", () => {
    expect(ratingLevels({ type: "labels", labels: ["Low", "High"] })).toEqual([
      { value: 0n, label: "Low" },
      { value: 1n, label: "High" },
    ]);
  });

  it("maps count scales to 1-based display labels", () => {
    expect(ratingLevels({ type: "count", count: 2 })).toEqual([
      { value: 0n, label: "1" },
      { value: 1n, label: "2" },
    ]);
  });

  it("enumerates small numeric scales on the step grid", () => {
    expect(
      ratingLevels({
        type: "numeric",
        constraints: { min: -2n, max: 2n, step: 2n },
      }),
    ).toEqual([
      { value: -2n, label: "-2" },
      { value: 0n, label: "0" },
      { value: 2n, label: "2" },
    ]);
  });

  it("returns null (→ free number input) for wide or degenerate scales", () => {
    expect(
      ratingLevels({
        type: "numeric",
        constraints: { min: 0n, max: 100n, step: 1n },
      }),
    ).toBeNull();
    expect(
      ratingLevels({
        type: "numeric",
        constraints: { min: 5n, max: 0n, step: 1n },
      }),
    ).toBeNull();
    expect(
      ratingLevels({
        type: "numeric",
        constraints: { min: 0n, max: 5n, step: 0n },
      }),
    ).toBeNull();
  });
});
