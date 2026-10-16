import { describe, expect, it } from "vitest";

import { squaresRules } from "./squares-layout";

/** The container query thresholds, in order. */
const thresholds = (css: string) =>
  [...css.matchAll(/\(width >= (\d+)px\) \{\n([^\n]*)/g)].map(
    ([, px, rule]) => [Number(px), rule!] as const,
  );

describe("squares layout", () => {
  it("puts 32 squares between the buttons at 16px from 896px, at 20px from 1024px", () => {
    const steps = thresholds(squaresRules({ name: "s", count: 32, room: 240 }));
    const [small, big] = steps.slice(-2);
    expect(small![0]).toBe(896);
    expect(small![1]).toContain("--sq: 16px");
    expect(big![0]).toBe(1024);
    expect(big![1]).toContain("--sq: 20px");
  });

  it("balances the lines above them: 16 and 16 from 380px", () => {
    const steps = thresholds(squaresRules({ name: "s", count: 32, room: 240 }));
    expect(steps).toContainEqual([
      380,
      '[data-squares-row="s"] [data-squares] { grid-template-columns: repeat(16, var(--sq)); }',
    ]);
    expect(steps.map(([px]) => px).filter((px) => px > 380)[0]).toBe(764);
  });

  it("keeps no room without buttons", () => {
    const steps = thresholds(squaresRules({ name: "s", count: 32 }));
    expect(steps.slice(-2).map(([px]) => px)).toEqual([636, 764]);
  });

  it("scrolls one line on a touch screen, the ladder kept for a mouse", () => {
    const css = squaresRules({ name: "s", count: 32, scroll: true });
    expect(css).toContain(
      "@media (hover: hover) and (pointer: fine) {\n@container s",
    );
    expect(css).toContain("@container s (width < 778px)");
  });
});
