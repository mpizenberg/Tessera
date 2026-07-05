import { describe, expect, it } from "vitest";

import { resultsView } from "./resultsRouting";

describe("resultsView", () => {
  it("shows the final artifact whenever one exists and raw isn't requested", () => {
    expect(resultsView(false, true, false)).toBe("final");
    expect(resultsView(true, true, false)).toBe("final"); // sealed too
  });

  it("falls back to the sealed client reveal for a sealed survey", () => {
    expect(resultsView(true, false, false)).toBe("sealed"); // no artifact yet
    expect(resultsView(true, true, true)).toBe("sealed"); // toggled off final
  });

  it("falls back to the raw on-chain tally for a public survey", () => {
    expect(resultsView(false, false, false)).toBe("raw"); // no artifact yet
    expect(resultsView(false, true, true)).toBe("raw"); // toggled off final
  });
});
