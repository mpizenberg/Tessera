import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Pure-logic tests (domain / tlock / wallet codecs) run in plain Node — no DOM,
// no solid plugin. Component tests, if added later, would need their own setup
// (jsdom + vite-plugin-solid). Aliases mirror vite.config.ts so imports resolve.
export default defineConfig({
  resolve: {
    alias: {
      // Subpath entries must precede the bare `cip-179` alias (matched in
      // order) — mirrors vite.config.ts.
      "cip-179/domain": r("../../packages/cip179/src/domain/index.ts"),
      "cip-179/tally": r("../../packages/cip179/src/tally/index.ts"),
      "cip-179/txproof": r("../../packages/cip179/src/txproof/index.ts"),
      "cip-179/tlock": r("../../packages/cip179/src/tlock/index.ts"),
      "cip-179": r("../../packages/cip179/src/index.ts"),
      "@tessera/core": r("../../packages/core/src/index.ts"),
      "@tessera/koios": r("../../packages/koios/src/index.ts"),
      "~": r("./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
