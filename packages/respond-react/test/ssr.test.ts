// @vitest-environment node
/**
 * Server-side rendering: importing the wrapper (and, transitively, the widget
 * artifact) without a DOM must be a no-op, and rendering the component to a
 * string must serialize the tag without warnings — React 18 would complain via
 * console.error if the wrapper used bare useLayoutEffect during server render.
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TesseraRespond } from "../src/index";
import { REQUIRED } from "./sample";

describe("TesseraRespond under SSR", () => {
  it("renders the tag to a string, silently", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToString(
      createElement(TesseraRespond, { ...REQUIRED, className: "host" }),
    );
    expect(html).toContain("<tessera-respond");
    expect(html).toContain('class="host"');
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
