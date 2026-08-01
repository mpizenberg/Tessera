import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// Two modes off one config:
// - `vite` (serve) roots at dev/, the harness that mounts `RespondRoot`
//   directly in a shadow root and logs the emitted events;
// - `vite build` produces the self-contained `<tessera-respond>` artifact
//   ES-only — Rollup can't code-split UMD, and the lazy sealed
//   chunks matter more than legacy script-tag support — with Solid,
//   respond-core, and the cip-179 codec bundled in (a script-tag host can't
//   install peers). The tlock/evolution chunks split out via the dynamic
//   imports in respond-core's seal.ts and load only when a sealed survey is
//   answered. CSS ships inside the JS (`?inline` → constructed stylesheet),
//   so there is no separate .css asset to forget.
export default defineConfig(({ command }) => ({
  // Event delegation is off because the compiler emits its
  // `delegateEvents([...])` registration at module scope, and that call
  // dereferences `window.document` — which would make merely importing the
  // artifact crash on a server (SSR hosts must be able to treat the import as
  // a no-op). Events bind directly on their elements instead; inside a shadow
  // root that is semantically identical.
  plugins: [solid({ solid: { delegateEvents: false } })],
  resolve: {
    alias: {
      // Resolve the workspace libraries straight from source so cross-package
      // edits stay live (and so vite-plugin-solid transforms respond-ui's JSX).
      // `cip-179` resolves via its own `exports` map (→ src) with no alias.
      "cardano-tessera-respond-core": r("../respond-core/src/index.ts"),
      "cardano-tessera-respond-ui": r("../respond-ui/src/index.ts"),
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
