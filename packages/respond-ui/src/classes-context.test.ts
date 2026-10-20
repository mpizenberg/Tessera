import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createRoot } from "solid-js";

import {
  BODY_CLASS_NAMES,
  IDENTITY_CLASSES,
  useClasses,
} from "./classes-context";

describe("classes context", () => {
  it("identity map covers every body class name with itself", () => {
    for (const name of BODY_CLASS_NAMES) {
      expect(IDENTITY_CLASSES[name]).toBe(name);
    }
  });

  it("defaults to identity when no provider is mounted (the widget's mode)", () => {
    const cls = createRoot((dispose) => {
      const c = useClasses();
      dispose();
      return c;
    });
    expect(cls).toBe(IDENTITY_CLASSES);
  });

  it("body.css styles every body class name, and only those", () => {
    const sheet = readFileSync(
      new URL("./body.css", import.meta.url),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const styled = new Set(
      [...sheet.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]),
    );
    expect([...styled].sort()).toEqual([...BODY_CLASS_NAMES].sort());
  });
});
