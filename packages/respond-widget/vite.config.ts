import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Two modes off one config:
// - `vite` (serve) roots at dev/, the harness that mounts `RespondRoot`
//   directly in a shadow root and logs the emitted events;
// - `vite build` produces the self-contained `<tessera-respond>` artifact
//   (plan §5): ES-only — Rollup can't code-split UMD, and the lazy sealed
//   chunks matter more than legacy script-tag support — with Solid,
//   respond-core, and the cip-179 codec bundled in (a script-tag host can't
//   install peers). The tlock/evolution chunks split out via the dynamic
//   imports in respond-core's seal.ts and load only when a sealed survey is
//   answered. CSS ships inside the JS (`?inline` → constructed stylesheet),
//   so there is no separate .css asset to forget.
export default defineConfig(({ command }) => ({
  plugins: [solid()],
  resolve: {
    alias: {
      // Resolve respond-core straight from source so cross-package edits stay
      // live. `cip-179` resolves via its own `exports` map (→ src) with no alias.
      "@tessera/respond-core": r("../respond-core/src/index.ts"),
    },
  },
  ...(command === "serve"
    ? {
        root: r("./dev"),
        // Bind IPv4 loopback so `localhost` connects (Vite defaults to `::1`).
        server: { host: "127.0.0.1", port: 3100 },
      }
    : {
        build: {
          lib: {
            entry: r("./src/element.tsx"),
            formats: ["es" as const],
            fileName: (f: string) => `tessera-respond.${f}.js`,
          },
          // Note: identifiers are minified but whitespace is kept — Vite's ES
          // lib builds preserve /*@__PURE__*/ annotations so bundler hosts can
          // still tree-shake; over the wire gzip erases the difference.
        },
      }),
}));
