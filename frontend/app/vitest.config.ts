import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Pure-logic tests (domain / tlock / wallet codecs) run in plain Node — no DOM,
// no solid plugin. Component tests, if added later, would need their own setup
// (jsdom + vite-plugin-solid). Aliases mirror vite.config.ts so imports resolve.
export default defineConfig({
  resolve: {
    alias: {
      "cip-179": r("../cip179/src/index.ts"),
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
