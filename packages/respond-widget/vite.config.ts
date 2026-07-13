import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Milestone 4: a dev harness only. The library build (`build.lib`, ES-only
// output, the lazy sealed chunks) is milestone 6 — this config just serves
// `dev/index.html`, which mounts `RespondRoot` into a shadow root and logs the
// emitted events.
export default defineConfig({
  root: r("./dev"),
  plugins: [solid()],
  resolve: {
    alias: {
      // Resolve respond-core straight from source so cross-package edits stay
      // live. `cip-179` resolves via its own `exports` map (→ src) with no alias.
      "@tessera/respond-core": r("../respond-core/src/index.ts"),
    },
  },
  // Bind IPv4 loopback so `localhost` connects (Vite defaults to IPv6 `::1`).
  server: { host: "127.0.0.1", port: 3100 },
});
