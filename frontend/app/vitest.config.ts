import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Pure-logic tests (domain / tlock / wallet codecs) run in plain Node — no DOM,
// no solid plugin. Component tests, if added later, would need their own setup
// (jsdom + vite-plugin-solid). Aliases mirror vite.config.ts so imports resolve.
export default defineConfig({
  resolve: {
    alias: {
      // Mirrors vite.config.ts; `cip-179` resolves via its src-pointing
      // exports map, no aliases needed.
      "cardano-tessera-core": r("../../packages/core/src/index.ts"),
      "cardano-tessera-koios": r("../../packages/koios/src/index.ts"),
      "cardano-tessera-respond-core": r(
        "../../packages/respond-core/src/index.ts",
      ),
      "cardano-tessera-respond-ui": r("../../packages/respond-ui/src/index.ts"),
      "~": r("./src"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
