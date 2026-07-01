import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      // Resolve the workspace libraries straight from their TypeScript source
      // so edits are live with no separate build step.
      "cip-179": r("../cip179/src/index.ts"),
      "@tessera/core": r("../../packages/core/src/index.ts"),
      "@tessera/koios": r("../../packages/koios/src/index.ts"),
      "~": r("./src"),
    },
  },
  // Bind IPv4 loopback so `localhost` (which many browsers resolve to
  // 127.0.0.1) connects — Vite's default binds IPv6 `::1` only.
  server: { host: "127.0.0.1", port: 3000 },
});
