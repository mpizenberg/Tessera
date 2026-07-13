/**
 * The plan-§4 token gate: the widget's public theming surface is the
 * --tessera-* custom-property namespace, with every default in src/theme.css.
 * Runs as part of `pnpm -r test`, so CI enforces it.
 *
 * - the component CSS carries no literal colors — every color routes through a
 *   token a host can override (via CSS or the `theme` prop);
 * - every custom property referenced anywhere in src/ is --tessera-* and is
 *   defined in theme.css (no typos, no leftovers from the app's global names);
 * - every token theme.css defines is consumed somewhere (no dead API surface).
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../src");

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** Drop block and line comments so prose mentioning tokens doesn't count. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "");
}

const files = walk(SRC)
  .filter((f) => /\.(css|tsx?)$/.test(f))
  .map((f) => ({
    path: relative(SRC, f),
    text: stripComments(readFileSync(f, "utf8")),
  }));

const themeCss = files.find((f) => f.path === "theme.css")!;

/** Tokens theme.css declares (`--tessera-x: value;`). */
const defined = new Set(
  [...themeCss.text.matchAll(/^\s*(--[\w-]+):/gm)].map((m) => m[1]!),
);

/** Custom properties referenced (`var(--x`) per file. */
const references = files.map((f) => ({
  path: f.path,
  vars: [...f.text.matchAll(/var\(\s*(--[\w-]+)/g)].map((m) => m[1]!),
}));

describe("theming tokens", () => {
  it("theme.css declares only --tessera-* custom properties", () => {
    for (const name of defined) {
      expect(name, "declared in theme.css").toMatch(/^--tessera-/);
    }
  });

  it("the component CSS has no literal colors — tokens only", () => {
    for (const f of files) {
      if (!f.path.endsWith(".css") || f.path === "theme.css") continue;
      const hexes = f.text.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
      expect(hexes, `literal colors in ${f.path}`).toEqual([]);
    }
  });

  it("every custom property referenced in src/ is a defined --tessera-* token", () => {
    for (const f of references) {
      for (const name of f.vars) {
        expect(name, `referenced in ${f.path}`).toMatch(/^--tessera-/);
        expect(
          defined.has(name),
          `${name} referenced in ${f.path} but not defined in theme.css`,
        ).toBe(true);
      }
    }
  });

  it("every defined token is referenced somewhere in src/", () => {
    const used = new Set(references.flatMap((f) => f.vars));
    for (const name of defined) {
      expect(used.has(name), `${name} defined but never referenced`).toBe(true);
    }
  });
});
