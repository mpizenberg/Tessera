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
      // Subpath entries must precede the bare `cip-179` alias: the alias
      // resolver matches in order and would otherwise rewrite `cip-179/domain`
      // to `.../index.ts/domain`.
      "cip-179/domain": r("../../packages/cip179/src/domain/index.ts"),
      "cip-179/tally": r("../../packages/cip179/src/tally/index.ts"),
      "cip-179/txproof": r("../../packages/cip179/src/txproof/index.ts"),
      "cip-179/tlock": r("../../packages/cip179/src/tlock/index.ts"),
      "cip-179/evolution": r("../../packages/cip179/src/evolution/index.ts"),
      "cip-179": r("../../packages/cip179/src/index.ts"),
      "@tessera/core": r("../../packages/core/src/index.ts"),
      "@tessera/koios": r("../../packages/koios/src/index.ts"),
      "~": r("./src"),
    },
  },
  // Bind IPv4 loopback so `localhost` (which many browsers resolve to
  // 127.0.0.1) connects — Vite's default binds IPv6 `::1` only.
  server: { host: "127.0.0.1", port: 3000 },
});
