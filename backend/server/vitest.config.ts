import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    alias: {
      // Vite 5 doesn't know `node:sqlite` as a builtin and fails to resolve
      // it, so tests importing `store-node.ts` load this shim instead — see
      // src/testing/node-sqlite.ts.
      "node:sqlite": fileURLToPath(
        new URL("./src/testing/node-sqlite.ts", import.meta.url),
      ),
    },
  },
});
