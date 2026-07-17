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
});
