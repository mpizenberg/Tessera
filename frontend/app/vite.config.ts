import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  plugins: [solid()],
  resolve: {
    alias: {
      // Resolve the workspace libraries straight from their TypeScript source
      // so edits are live with no separate build step. `cip-179` needs no
      // aliases: its exports map points at src, which Vite resolves directly.
      "@tessera/core": r("../../packages/core/src/index.ts"),
      "@tessera/koios": r("../../packages/koios/src/index.ts"),
      "@tessera/respond-core": r("../../packages/respond-core/src/index.ts"),
      "@tessera/respond-ui": r("../../packages/respond-ui/src/index.ts"),
      // The embeddable widget is consumed from source too, so the dev-only
      // reference-host page (`/dev/widget/:key`) drives the very
      // same code the built artifact ships. The `/element` subpath registers
      // the `<tessera-respond>` custom element.
      "@tessera/respond-widget/element": r(
        "../../packages/respond-widget/src/element.tsx",
      ),
      "@tessera/respond-widget": r(
        "../../packages/respond-widget/src/index.ts",
      ),
      "~": r("./src"),
    },
    // The widget pulls in `solid-element`, so two Solid copies could otherwise
    // slip in (breaking context/ownership). Force a single instance.
    dedupe: ["solid-js", "solid-element"],
  },
  // Bind IPv4 loopback so `localhost` (which many browsers resolve to
  // 127.0.0.1) connects — Vite's default binds IPv6 `::1` only.
  server: { host: "127.0.0.1", port: 3000 },
});
