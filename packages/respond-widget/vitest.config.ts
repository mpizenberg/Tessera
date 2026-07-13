import { defineConfig } from "vitest/config";

// Standalone test config: without it vitest would load this package's
// vite.config.ts, whose `root: ./dev` (the dev harness) would point test
// discovery at the wrong tree.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
